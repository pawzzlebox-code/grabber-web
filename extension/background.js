// Create context menu + cookie sync alarm on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'grabber-download',
    title: 'Download with Grabber',
    contexts: ['page', 'link', 'video', 'audio']
  })
  // Auto-sync cookies every 10 minutes
  chrome.alarms.create('cookie-sync', { periodInMinutes: 10 })
})

// Handle cookie sync alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'cookie-sync') {
    // x.com is listed separately from twitter.com: since the rebrand the
    // login cookies (auth_token / ct0) live on .x.com, while twitter.com
    // only keeps guest cookies. Syncing twitter.com alone left the server
    // logged out, so anything gated (sensitive media, protected accounts)
    // came back as "No video could be found in this tweet".
    for (const domain of ['youtube.com', 'instagram.com', 'twitter.com', 'x.com']) {
      await syncCookiesToDesktop(domain)
    }
    console.log('[Grabber Helper] Auto-synced cookies')
  }
})

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'grabber-download') return
  const url = info.linkUrl || info.pageUrl || tab?.url
  if (!url) return
  await sendToGrabber(url)
})

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'grab') {
    sendToGrabber(msg.url).then(sendResponse)
    return true
  }
  if (msg.action === 'syncCookies') {
    syncCookiesToDesktop(msg.domain).then(sendResponse)
    return true
  }
})

// Auto-sync cookies when visiting YouTube (keeps desktop app's cookie file fresh)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    try {
      const host = new URL(tab.url).hostname
      if (host.includes('youtube.com') || host.includes('youtu.be')) {
        await syncCookiesToDesktop('youtube.com')
      } else if (host.includes('instagram.com')) {
        await syncCookiesToDesktop('instagram.com')
      } else if (host.includes('twitter.com') || host.includes('x.com')) {
        // Both, in this order — x.com carries the actual login.
        await syncCookiesToDesktop('x.com')
        await syncCookiesToDesktop('twitter.com')
      }
    } catch {}
  }
})

async function sendToGrabber(videoUrl) {
  try {
    const { serverUrl } = await chrome.storage.sync.get({ serverUrl: 'http://localhost:3000' })
    const urlObj = new URL(videoUrl)
    const domain = urlObj.hostname

    const cookies = await getCookiesForDomain(domain)
    const cookiesTxt = toCookiesTxt(cookies)

    // Send to web app server
    const res = await fetch(`${serverUrl}/api/grab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: videoUrl, cookies: cookiesTxt })
    })

    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed')

    // Also sync cookies to desktop app if running
    syncCookiesToDesktop(domain).catch(() => {})

    return { success: true, id: data.id }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function syncCookiesToDesktop(domain) {
  const targetDomain = domain || 'youtube.com'
  const cookies = await getCookiesForDomain(targetDomain)
  const cookiesTxt = toCookiesTxt(cookies)

  // Sync to desktop app (localhost)
  try {
    const res = await fetch('http://127.0.0.1:9876/cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: cookiesTxt })
    })
    if (res.ok) console.log('[Grabber Helper] Cookies synced to desktop app')
  } catch {}

  // Sync to web server (Railway)
  try {
    const { serverUrl, cookieKey } = await chrome.storage.sync.get({ serverUrl: 'http://localhost:3000', cookieKey: '' })
    const serverRes = await fetch(`${serverUrl}/api/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cookie-key': cookieKey },
      body: JSON.stringify({ cookies: cookiesTxt })
    })
    if (!serverRes.ok) {
      const err = await serverRes.json().catch(() => ({}))
      console.error('[Grabber Helper] Server sync failed:', serverRes.status, err.error)
      return { success: false, error: `Server: ${err.error || serverRes.status}` }
    }
    console.log('[Grabber Helper] Cookies synced to web server')
  } catch (err) {
    console.error('[Grabber Helper] Server sync error:', err.message)
    return { success: false, error: err.message }
  }

  return { success: true }
}

async function getCookiesForDomain(hostname) {
  // Domain-based query alone misses some session cookies (Instagram's
  // `sessionid` / `ds_user_id` in particular). Combine with URL-based
  // queries — those return every cookie Chrome would send on a request
  // to that URL, including HttpOnly / SameSite=None / partitioned ones
  // that the domain query skips.
  const baseHost = hostname.replace(/^www\./, '')
  const domains = [hostname, '.' + hostname]
  const parts = hostname.split('.')
  if (parts.length > 2) {
    domains.push('.' + parts.slice(-2).join('.'))
  } else {
    domains.push('.' + hostname)
  }
  const urls = [
    `https://${hostname}/`,
    `https://www.${baseHost}/`,
    `https://${baseHost}/`,
  ]
  // Instagram routes login through accounts.instagram.com which holds
  // some auth cookies on its own domain — fetch those explicitly.
  if (baseHost.endsWith('instagram.com')) {
    urls.push('https://accounts.instagram.com/')
    urls.push('https://i.instagram.com/')
  }

  const allCookies = []
  const seen = new Set()
  const addCookie = (c) => {
    const key = `${c.domain}|${c.name}|${c.path}`
    if (!seen.has(key)) { seen.add(key); allCookies.push(c) }
  }

  // Default store (no storeId) — what was working pre-fix for non-session
  // cookies. Plus URL-based queries to catch HttpOnly/SameSite=None cookies
  // that domain queries sometimes skip.
  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain })
      cookies.forEach(addCookie)
    } catch {}
  }
  for (const url of urls) {
    try {
      const cookies = await chrome.cookies.getAll({ url })
      cookies.forEach(addCookie)
    } catch {}
  }

  // Best-effort: also try every other cookie store Chrome exposes. Don't
  // REPLACE the default-store query — augment, so we never lose cookies
  // when the alternate stores are empty.
  try {
    const stores = await chrome.cookies.getAllCookieStores()
    for (const store of (stores || [])) {
      for (const url of urls) {
        try {
          const cookies = await chrome.cookies.getAll({ url, storeId: store.id })
          cookies.forEach(addCookie)
        } catch {}
      }
    }
  } catch {}

  return allCookies
}

function toCookiesTxt(cookies) {
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of cookies) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const secure = c.secure ? 'TRUE' : 'FALSE'
    const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0
    lines.push(`${domain}\t${includeSubdomains}\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`)
  }
  return lines.join('\n')
}
