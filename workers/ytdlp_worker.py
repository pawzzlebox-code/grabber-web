#!/usr/bin/env python3
"""
Long-running yt-dlp worker. Imports yt_dlp once at boot and then handles
JSON commands over stdin/stdout. Eliminates the ~500-1000ms Python
interpreter + extractor-load cost on each download.

Protocol (JSON per line):
  in:  {"type":"download","job_id":"...","url":"...","format":"...",
         "outtmpl":"...","proxy":"...","cookies":"...",
         "playlist_items":"...","no_playlist":true}
  in:  {"type":"ping"}
  out: {"type":"ready"}                                         # on boot
  out: {"type":"status","job_id":"...","message":"..."}
  out: {"type":"progress","job_id":"...","percent":12.5,
        "speed_bps":5242880,"eta":30,"total_bytes":123456}
  out: {"type":"done","job_id":"...","filepath":"/tmp/..."}
  out: {"type":"error","job_id":"...","message":"..."}
  out: {"type":"pong"}
"""
import sys
import os
import json
import traceback

# Force UTF-8 to match the previous CLI env vars
os.environ.setdefault('PYTHONUTF8', '1')
os.environ.setdefault('PYTHONIOENCODING', 'utf-8')

from yt_dlp import YoutubeDL


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


class JobContext:
    def __init__(self, job_id):
        self.job_id = job_id
        self.final_filepath = None


def make_progress_hook(ctx):
    def hook(d):
        status = d.get('status')
        if status == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            downloaded = d.get('downloaded_bytes') or 0
            percent = (downloaded / total * 100) if total else 0
            emit({
                'type': 'progress',
                'job_id': ctx.job_id,
                'percent': round(percent, 2),
                'speed_bps': d.get('speed') or 0,
                'eta': d.get('eta') or 0,
                'total_bytes': total,
                'downloaded_bytes': downloaded,
            })
        elif status == 'finished':
            # Download done, may still have post-processing (merge, fixup)
            emit({
                'type': 'status',
                'job_id': ctx.job_id,
                'message': 'Merging...',
            })
        elif status == 'error':
            emit({
                'type': 'status',
                'job_id': ctx.job_id,
                'message': 'Download error',
            })
    return hook


def make_post_hook(ctx):
    def hook(filename):
        # post_hooks fires after all post-processors finish. The argument is
        # the final filepath of the moved file.
        ctx.final_filepath = filename
    return hook


def run_download(cmd):
    ctx = JobContext(cmd['job_id'])
    # Fake Chrome's TLS/HTTP/2 fingerprint via curl-cffi when available.
    # Bypasses sites that 410-block yt-dlp's stock urllib fingerprint
    # (Pornhub etc.). Silently no-ops if curl-cffi isn't installed.
    impersonate = None
    try:
        from yt_dlp.networking.impersonate import ImpersonateTarget
        impersonate = ImpersonateTarget(client='chrome')
    except Exception:
        pass

    opts = {
        'outtmpl': {'default': cmd['outtmpl']},
        'format': cmd.get('format') or 'bestvideo*+bestaudio/best',
        # Prefer H.264 video + AAC audio when the site offers them (YouTube
        # keeps H.264 copies of everything up to 1080p). H.264+AAC needs NO
        # client-side transcode for iOS Photos — the 10+ minute WebCodecs
        # re-encode simply never runs. This is a soft preference, not a
        # filter: sites without H.264 fall back to their best codec exactly
        # as before. Composes with the height caps in the format strings.
        #
        # 'res' MUST come first. Without it these codec preferences outrank
        # resolution, and since YouTube's itag 18 (360p progressive) is the
        # only stream that is BOTH h264 and aac, it beat every high-res
        # video-only format: picking "Best" on a 4K video silently returned
        # 360p. Resolution decides first; codec only breaks ties within the
        # same resolution.
        'format_sort': ['res', 'vcodec:h264', 'acodec:aac'],
        'noplaylist': cmd.get('no_playlist', True),
        # Keep going when an individual item in a multi-item extraction fails.
        # Pages scraped by the generic extractor (Snapchat shares especially)
        # expose several media URLs, some of which yt-dlp refuses on sight
        # ("The extracted extension ('IRZXSOY') is unusual"). Without this the
        # first junk entry aborted the whole job even though the real video
        # sat right behind it. The existence check after the download keeps
        # this from turning a total failure into a silent success.
        'ignoreerrors': 'only_download',
        'check_formats': False,
        'updatetime': False,
        # Droplet now has 1GB RAM (~490MB free). Download 4 fragments in
        # parallel with 4MB chunks — much faster on HLS/DASH (hides per-fragment
        # latency) while staying well within memory. We previously had to
        # serialize to 1 fragment on the 512MB box because 8 concurrent
        # curl_cffi(+SOCKS5) fetches under memory pressure corrupted the heap
        # (SIGABRT). 4 is a safe middle ground; the proxy-heavy crash path is
        # also avoided now that flaky sites bypass the proxy entirely.
        'concurrent_fragment_downloads': 4,
        'http_chunk_size': 4 * 1024 * 1024,
        'retries': 3,
        'fragment_retries': 5,
        'quiet': True,
        # Suppress yt-dlp's built-in "[download] 45%..." progress bar. It was
        # being written to the worker's stdout and concatenated onto our JSON
        # protocol lines, so every progress message failed to parse ("bad
        # line") on the Node side. We report progress via progress_hooks only.
        'noprogress': True,
        'no_warnings': False,
        'progress_hooks': [make_progress_hook(ctx)],
        'post_hooks': [make_post_hook(ctx)],
        # Enable YouTube's signature/n challenge solver. Without ejs:github
        # YouTube returns only storyboards for most modern videos.
        'remote_components': ['ejs:github'],
        # NOTE: we deliberately do NOT pin player_client. yt-dlp's default set
        # (android_sdkless,web,web_safari) is already the fastest combo that
        # yields downloadable formats without a PO token — benchmarks showed
        # pinning to tv/web_safari was slower or broke downloadability.
    }
    if impersonate is not None:
        opts['impersonate'] = impersonate
    # Audio-only: ask yt-dlp to extract to MP3 so apps like CapCut (which
    # rejects webm/opus / m4a/AAC-LC raw streams) can import the file.
    if cmd.get('audio_only'):
        opts['postprocessors'] = [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }]
    if cmd.get('playlist_items'):
        opts['playlist_items'] = str(cmd['playlist_items'])
    if cmd.get('proxy'):
        opts['proxy'] = cmd['proxy']
    if cmd.get('cookies'):
        opts['cookiefile'] = cmd['cookies']

    emit({'type': 'status', 'job_id': ctx.job_id, 'message': 'Extracting...'})

    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(cmd['url'], download=True)
        # Prefer the post_hook-captured path (post-merge); fall back to
        # requested_downloads or prepare_filename.
        filepath = ctx.final_filepath
        if not filepath:
            requested = (info or {}).get('requested_downloads') or []
            if requested:
                filepath = requested[0].get('filepath') or requested[0].get('_filename')
        if not filepath and info:
            filepath = ydl.prepare_filename(info)
        # With ignoreerrors on, yt-dlp can finish "successfully" having saved
        # nothing at all. Only call it done if a real file landed on disk.
        if not filepath or not os.path.exists(filepath):
            raise Exception('yt-dlp produced no downloadable file for this URL')
        emit({'type': 'done', 'job_id': ctx.job_id, 'filepath': filepath})


def run_extract_info(cmd):
    """Metadata-only extraction (no download). Runs in the warm worker so it
    skips the ~0.5-1.5s cold Python+extractor load a fresh CLI spawn pays."""
    impersonate = None
    try:
        from yt_dlp.networking.impersonate import ImpersonateTarget
        impersonate = ImpersonateTarget(client='chrome')
    except Exception:
        pass

    opts = {
        'noplaylist': cmd.get('no_playlist', True),
        'check_formats': False,
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'remote_components': ['ejs:github'],
        # No player_client pin — default set is fastest (see run_download note).
    }
    if impersonate is not None:
        opts['impersonate'] = impersonate
    if cmd.get('proxy'):
        opts['proxy'] = cmd['proxy']
    if cmd.get('cookies'):
        opts['cookiefile'] = cmd['cookies']

    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(cmd['url'], download=False)
        # sanitize_info strips non-JSON-serializable internals.
        info = ydl.sanitize_info(info)
        emit({'type': 'info', 'job_id': cmd.get('job_id'), 'info': info})


def main():
    emit({'type': 'ready'})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception as e:
            emit({'type': 'error', 'job_id': None, 'message': f'bad json: {e}'})
            continue
        ctype = cmd.get('type')
        if ctype == 'download':
            try:
                run_download(cmd)
            except Exception as e:
                emit({
                    'type': 'error',
                    'job_id': cmd.get('job_id'),
                    'message': str(e),
                    'traceback': traceback.format_exc(),
                })
        elif ctype == 'extract_info':
            try:
                run_extract_info(cmd)
            except Exception as e:
                emit({
                    'type': 'error',
                    'job_id': cmd.get('job_id'),
                    'message': str(e),
                    'traceback': traceback.format_exc(),
                })
        elif ctype == 'ping':
            emit({'type': 'pong'})
        else:
            emit({'type': 'error', 'job_id': cmd.get('job_id'), 'message': f'unknown type: {ctype}'})


if __name__ == '__main__':
    main()
