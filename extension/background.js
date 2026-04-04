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
    for (const domain of ['youtube.com', 'instagram.com', 'twitter.com']) {
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
    syncCookiesToDesktop().then(sendResponse)
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
    await fetch(`${serverUrl}/api/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cookie-key': cookieKey },
      body: JSON.stringify({ cookies: cookiesTxt })
    })
    console.log('[Grabber Helper] Cookies synced to web server')
  } catch {}

  return { success: true }
}

async function getCookiesForDomain(hostname) {
  const domains = [hostname]
  const parts = hostname.split('.')
  if (parts.length > 2) {
    domains.push('.' + parts.slice(-2).join('.'))
  } else {
    domains.push('.' + hostname)
  }

  const allCookies = []
  const seen = new Set()

  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain })
      for (const c of cookies) {
        const key = `${c.domain}|${c.name}|${c.path}`
        if (!seen.has(key)) {
          seen.add(key)
          allCookies.push(c)
        }
      }
    } catch {}
  }

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
