"""Personal PC speech helper. Only explicitly listed frontend files are served."""
import argparse
import asyncio
from collections import OrderedDict
from contextlib import suppress
import math
from pathlib import Path
import secrets
import string
import sys

from aiohttp import web
import edge_tts

ROOT = Path(__file__).resolve().parent
FRONTEND = ('index.html', 'style.css', 'speech.js', 'edge-speech.js', 'app.js',
            'library.js', 'library-ui.js', 'dexie.js', 'dexie.LICENSE')


def create_server_loop():
    # Python 3.13's Windows Proactor transport can raise during shutdown()
    # after a peer resets a socket, interrupting the rest of its cleanup.
    # This HTTP/WebSocket service needs no subprocess or pipe transports.
    # Use the socket-based selector loop instead of suppressing exceptions.
    if sys.platform == 'win32':
        return asyncio.SelectorEventLoop()
    return asyncio.new_event_loop()


async def console_wakeup(app):
    """Let Windows process Ctrl+C even when the selector has no socket events."""
    async def tick():
        while True:
            await asyncio.sleep(0.25)

    task = asyncio.create_task(tick())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


def load_access_key(path):
    token = path.read_text(encoding='utf-8').strip() if path.exists() else ''
    if len(token) != 4 or any(letter not in string.ascii_lowercase for letter in token):
        token = ''.join(secrets.choice(string.ascii_lowercase) for _ in range(4))
        path.write_text(token, encoding='utf-8')
    return token


def create_app(token, origins=(), communicate=edge_tts.Communicate, list_voices=edge_tts.list_voices):
    cache = OrderedDict()
    voice_names = set()
    gate = asyncio.Semaphore(2)

    @web.middleware
    async def access(request, handler):
        origin = request.headers.get('Origin')
        same_origin = f'{request.scheme}://{request.host}'
        if origin and origin != same_origin and origin not in origins:
            return web.json_response({'error': 'Origin not allowed'}, status=403)
        if request.method == 'OPTIONS':
            response = web.Response(status=204)
        elif request.path.startswith('/api/') and not secrets.compare_digest(
                request.headers.get('Authorization', ''), f'Bearer {token}'):
            response = web.json_response({'error': 'Check your PC access key'}, status=401)
        else:
            try:
                response = await handler(request)
            except web.HTTPException as exc:
                response = web.Response(status=exc.status, text=exc.text)
        if origin:
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Vary'] = 'Origin'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
        response.headers['Cache-Control'] = 'no-store'
        return response

    async def voices(request):
        try:
            async with asyncio.timeout(10):
                entries = await list_voices()
            voice_names.update(v['ShortName'] for v in entries)
            return web.json_response([{'name': v['ShortName'], 'locale': v['Locale'],
                                       'gender': v['Gender']} for v in entries])
        except Exception:
            return web.json_response({'error': 'Microsoft voice list unavailable'}, status=502)

    async def speech(request):
        try:
            data = await request.json()
            if not isinstance(data, dict):
                raise ValueError()
            text, voice, rate = data.get('text'), data.get('voice'), data.get('rate', 1)
            if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                raise ValueError()
            if not isinstance(voice, str) or voice not in voice_names:
                raise ValueError()
            if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not math.isfinite(rate) or not .5 <= rate <= 1.5:
                raise ValueError()
        except (ValueError, TypeError):
            return web.json_response({'error': 'Invalid text, voice, or speed. Load voices first.'}, status=400)
        key = (text, voice, rate)
        if key not in cache:
            try:
                async with asyncio.timeout(11):
                    async with gate:
                        audio = bytearray()
                        async for chunk in communicate(text, voice, rate=f'{round((rate - 1) * 100):+d}%').stream():
                            if chunk['type'] == 'audio':
                                audio.extend(chunk['data'])
                        if not audio:
                            raise ValueError('No audio')
                        cache[key] = bytes(audio)
                        while len(cache) > 100:
                            cache.popitem(last=False)
            except Exception:
                return web.json_response({'error': 'Edge speech unavailable'}, status=502)
        cache.move_to_end(key)
        return web.Response(body=cache[key], content_type='audio/mpeg')

    async def frontend(request):
        name = request.match_info.get('name', 'index.html')
        if name not in FRONTEND:
            raise web.HTTPNotFound()
        # These allowlisted assets are small. Buffer each response independently:
        # the phone received same-length, altered Dexie source through FileResponse
        # on the Windows selector-loop server. Avoid its sendfile transport path.
        path = ROOT / name
        try:
            body = await asyncio.to_thread(path.read_bytes)
        except FileNotFoundError:
            raise web.HTTPNotFound()
        content_type = {'.html': 'text/html', '.css': 'text/css',
                        '.js': 'text/javascript'}.get(path.suffix, 'text/plain')
        return web.Response(body=body, content_type=content_type,
                            headers={'X-Reciter-Static': 'buffered-v1'})

    async def options(request):
        return web.Response(status=204)

    app = web.Application(middlewares=[access], client_max_size=16384)
    if sys.platform == 'win32':
        app.cleanup_ctx.append(console_wakeup)
    app.router.add_get('/api/voices', voices)
    app.router.add_post('/api/speech', speech)
    app.router.add_route('OPTIONS', '/api/{name}', options)
    app.router.add_get('/', frontend)
    app.router.add_get('/{name}', frontend)
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--origin', action='append', default=[], help='Allowed frontend origin, e.g. https://reciter.example')
    args = parser.parse_args()
    token_file = ROOT / '.reciter-token'
    token = load_access_key(token_file)
    print(f'PC access key (paste into Reciter): {token}')
    print('Open http://<PC-LAN-IP>:' + str(args.port) + ' on your phone, on the same Wi-Fi.')
    print('Press Ctrl+C to stop (active requests get up to 3 seconds to finish).')
    web.run_app(create_app(token, args.origin), host=args.host, port=args.port,
                access_log=None, loop=create_server_loop(), shutdown_timeout=3)
