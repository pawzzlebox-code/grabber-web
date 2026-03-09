// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'grabber-download',
    title: 'Download with Grabber',
    contexts: ['page', 'link', 'video', 'audio']
  })
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
    return true // async response
  }
})

async function sendToGrabber(videoUrl) {
  try {
    // Get server URL from storage
    const { serverUrl } = await chrome.storage.sync.get({ serverUrl: 'http://localhost:3000' })

    // Extract domain from video URL for cookies
    const urlObj = new URL(videoUrl)
    const domain = urlObj.hostname

    // Get cookies for the video site
    const cookies = await getCookiesForDomain(domain)
    const cookiesTxt = toCookiesTxt(cookies)

    // Send to Grabber server
    const res = await fetch(`${serverUrl}/api/grab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: videoUrl, cookies: cookiesTxt })
    })

    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed')

    return { success: true, id: data.id }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function getCookiesForDomain(hostname) {
  // Get cookies for the domain and common subdomains
  const domains = [hostname]

  // Add parent domain (e.g., .youtube.com from www.youtube.com)
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
