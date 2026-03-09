const videoHosts = [
  'youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com',
  'tiktok.com', 'instagram.com', 'twitter.com', 'x.com',
  'facebook.com', 'twitch.tv', 'reddit.com'
]

function isVideoUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return videoHosts.some(h => host.includes(h))
  } catch { return false }
}

async function init() {
  // Load server URL
  const { serverUrl } = await chrome.storage.sync.get({ serverUrl: 'http://localhost:3000' })
  document.getElementById('server-url').value = serverUrl

  // Save server URL on change
  document.getElementById('server-url').addEventListener('change', (e) => {
    chrome.storage.sync.set({ serverUrl: e.target.value.replace(/\/+$/, '') })
  })

  // Get current tab URL
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url || ''

  if (!isVideoUrl(url)) {
    document.getElementById('video-section').style.display = 'none'
    document.getElementById('no-video').style.display = 'block'
    return
  }

  document.getElementById('url-display').textContent = url

  // Download button
  document.getElementById('grab-btn').addEventListener('click', async () => {
    const btn = document.getElementById('grab-btn')
    const status = document.getElementById('status')

    btn.disabled = true
    btn.innerHTML = '<span>Sending...</span>'

    const result = await chrome.runtime.sendMessage({ action: 'grab', url })

    status.style.display = 'block'
    if (result.success) {
      status.className = 'status success'
      status.textContent = 'Sent to Grabber! Check your server.'
      btn.innerHTML = 'Sent!'
    } else {
      status.className = 'status error'
      status.textContent = result.error || 'Failed to send'
      btn.disabled = false
      btn.innerHTML = 'Retry'
    }
  })
}

init()
