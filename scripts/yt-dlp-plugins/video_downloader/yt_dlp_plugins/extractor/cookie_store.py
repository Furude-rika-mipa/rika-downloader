"""Per-site cookie cache encrypted for the current Windows account."""
import ctypes
from ctypes import wintypes
import http.cookiejar
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
import uuid

__all__ = []
_FIELDS = ('version', 'name', 'value', 'port', 'port_specified', 'domain', 'domain_specified',
           'domain_initial_dot', 'path', 'path_specified', 'secure', 'expires', 'discard',
           'comment', 'comment_url', 'rfc2109')


def site_scopes(url):
    host = (urlsplit(url).hostname or '').encode('idna').decode('ascii').lower().rstrip('.')
    if not host or any(ch not in 'abcdefghijklmnopqrstuvwxyz0123456789.-' for ch in host):
        raise ValueError('Invalid video website')
    groups = (
        ('youtube.com', ('youtube.com', 'youtu.be', 'google.com', 'googlevideo.com')),
        ('bilibili.com', ('bilibili.com', 'b23.tv', 'bilivideo.com')),
        ('douyin.com', ('douyin.com', 'iesdouyin.com', 'douyinvod.com')),
        ('xiaohongshu.com', ('xiaohongshu.com', 'xhslink.com')),
        ('x.com', ('x.com', 'twitter.com', 'twimg.com')),
        ('yangshipin.cn', ('yangshipin.cn',)),
    )
    for name, domains in groups:
        if any(host == domain or host.endswith('.' + domain) for domain in domains):
            return name, domains
    return host, (host,)


def matches_scope(cookie, domains):
    domain = (cookie.domain or '').lstrip('.').lower().rstrip('.')
    if len(domain.split('.')) < 2:
        return False
    return any(domain == site or domain.endswith('.' + site) or site.endswith('.' + domain) for site in domains)


class _Blob(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]


def _protect(data, decrypt=False):
    if os.name != 'nt':
        raise OSError('Windows encrypted storage is unavailable')
    payload = ctypes.create_string_buffer(data)
    source = _Blob(len(data), ctypes.cast(payload, ctypes.POINTER(ctypes.c_ubyte)))
    result = _Blob()
    if decrypt:
        ok = ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
    else:
        ok = ctypes.windll.crypt32.CryptProtectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(ctypes.cast(result.pbData, wintypes.HLOCAL))


class SiteCookieCache:
    def __init__(self, browser, url, jar_class):
        self.browser = browser
        self.site, self.domains = site_scopes(url)
        self.jar_class = jar_class
        local = os.environ.get('LOCALAPPDATA', '')
        self.directory = Path(local) / '视频下载器' / '浏览器会话' if local else None
        self.file = self.directory / (f'{browser}--{self.site}.bin') if self.directory else None

    def scoped(self, jar):
        result = self.jar_class()
        for cookie in jar:
            if matches_scope(cookie, self.domains) and not cookie.is_expired():
                result.set_cookie(cookie)
        return result

    def save(self, jar):
        if self.file is None:
            return False
        temp = None
        try:
            items = []
            for cookie in self.scoped(jar):
                item = {field: getattr(cookie, field) for field in _FIELDS}
                item['rest'] = dict(cookie._rest)
                items.append(item)
            content = json.dumps({'version': 1, 'browser': self.browser, 'site': self.site, 'cookies': items},
                                 ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            if len(content) > 8 * 1024 * 1024:
                return False
            encrypted = _protect(content)
            self.directory.mkdir(parents=True, exist_ok=True)
            temp = self.directory / ('.' + self.file.name + '.' + uuid.uuid4().hex + '.tmp')
            with temp.open('xb') as out:
                out.write(encrypted)
            os.replace(temp, self.file)
            return True
        except Exception:
            if temp:
                try:
                    temp.unlink(missing_ok=True)
                except OSError:
                    pass
            return False

    def load(self):
        if self.file is None:
            return None
        try:
            with self.file.open('rb') as source:
                encrypted = source.read(8 * 1024 * 1024 + 65536)
            if len(encrypted) > 8 * 1024 * 1024 + 32768:
                return None
            saved = json.loads(_protect(encrypted, decrypt=True).decode('utf-8'))
            if saved.get('version') != 1 or saved.get('browser') != self.browser or saved.get('site') != self.site:
                return None
            jar = self.jar_class()
            for values in saved.get('cookies', []):
                cookie = http.cookiejar.Cookie(**values)
                if matches_scope(cookie, self.domains) and not cookie.is_expired():
                    jar.set_cookie(cookie)
            return jar if len(jar) else None
        except Exception:
            return None
