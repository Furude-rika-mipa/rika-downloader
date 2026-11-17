"""Read browser sessions in memory and reuse a per-site encrypted Windows cache."""
import os
from pathlib import Path
import sqlite3
import sys
import time

__all__ = []

_browser = os.environ.get('VIDEO_DOWNLOADER_COOKIE_BROWSER', '')
if _browser:
    if _browser not in {'extension', 'chrome', 'edge', 'brave', 'vivaldi', 'chromium', 'opera', 'firefox'}:
        raise ValueError('Unsupported browser selection')
    from yt_dlp import YoutubeDL, cookies
    from .cookie_store import SiteCookieCache

    if not callable(getattr(cookies, '_open_database_copy', None)) or not hasattr(sqlite3.Connection, 'backup'):
        raise RuntimeError('In-memory browser cookie reader is unavailable')

    def _open_database_in_memory(database_path, _unused_tempdir):
        source = sqlite3.connect(Path(database_path).resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        destination = None
        try:
            source.execute('PRAGMA query_only=ON')
            pages = source.execute('PRAGMA page_count').fetchone()[0]
            page_size = source.execute('PRAGMA page_size').fetchone()[0]
            if pages * page_size > 256 * 1024 * 1024:
                raise RuntimeError('Browser cookie database is too large to read in memory')
            destination = sqlite3.connect(':memory:')
            destination.execute('PRAGMA temp_store=MEMORY')
            deadline = time.monotonic() + 5
            def progress(_status, _remaining, _total):
                if time.monotonic() > deadline:
                    raise TimeoutError('Reading browser cookie database timed out')
            source.backup(destination, pages=128, progress=progress, sleep=0.05)
            return destination.cursor()
        except BaseException:
            if destination is not None:
                destination.close()
            raise
        finally:
            source.close()

    _original_init = YoutubeDL.__init__
    def _init_with_browser_cookies(self, params=None, auto_init=True):
        options = dict(params or {})
        options['cookiefile'] = None
        cache = SiteCookieCache(_browser, os.environ.get('VIDEO_DOWNLOADER_COOKIE_URL', ''), cookies.YoutubeDLCookieJar)
        refreshing = os.environ.get('VIDEO_DOWNLOADER_COOKIE_REFRESH') == '1'
        cached = None if refreshing else cache.load()
        if _browser == 'extension' and cached is None:
            print('__VIDEO_COOKIE_CACHE_EMPTY__', file=sys.stderr, flush=True)
            raise RuntimeError('No saved extension session for this website')
        if cached is None:
            options['cookiesfrombrowser'] = (_browser, None, None, None)
        else:
            options['cookiesfrombrowser'] = None
            self.__dict__['cookiejar'] = cached
        _original_init(self, options, auto_init)
        if cached is None:
            self.__dict__['cookiejar'] = cache.scoped(self.cookiejar)
            if len(self.cookiejar) == 0:
                print('__VIDEO_COOKIE_CACHE_EMPTY__', file=sys.stderr, flush=True)
                raise RuntimeError('No browser session for this website')
            state = 'REFRESHED' if refreshing else ('SAVED' if cache.save(self.cookiejar) else 'SAVE_FAILED')
        else:
            if len(cached) == 0:
                print('__VIDEO_COOKIE_CACHE_EMPTY__', file=sys.stderr, flush=True)
                raise RuntimeError('No browser session for this website')
            state = 'HIT'
        print('__VIDEO_COOKIE_CACHE_' + state + '__', file=sys.stderr, flush=True)
        if refreshing:
            def save_refreshed(_filename):
                result = 'REFRESH_SAVED' if cache.save(self.cookiejar) else 'SAVE_FAILED'
                print('__VIDEO_COOKIE_CACHE_' + result + '__', file=sys.stderr, flush=True)
            self.add_post_hook(save_refreshed)
        else:
            self.add_close_hook(lambda: cache.save(self.cookiejar))

    # Both hooks must be installed before the browser is ever opened.
    cookies._open_database_copy = _open_database_in_memory
    YoutubeDL.__init__ = _init_with_browser_cookies
    print('__VIDEO_COOKIE_MEMORY_READY__', file=sys.stderr, flush=True)
