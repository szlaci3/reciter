"""Explicit live check: sends only the sample below to Microsoft, never user text."""
import asyncio
import argparse
import getpass
import os
import re
from urllib.parse import urlsplit
from aiohttp import ClientSession, ClientTimeout
from aiohttp.test_utils import TestClient, TestServer
from server import create_app, create_server_loop


async def check(client, token, origin=None):
    response = await client.get('/healthz', timeout=ClientTimeout(total=90))
    assert response.status == 200, f'Health check: HTTP {response.status}'
    assert await response.json() == {'status': 'ok'}
    await response.read()
    response = await client.get('/api/voices')
    assert response.status == 401, f'Unauthenticated API must return 401, got {response.status}'
    await response.read()
    headers = {'Authorization': 'Bearer ' + token}
    if origin:
        headers['Origin'] = origin
        response = await client.options('/api/speech', headers={
            'Origin': origin, 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization,content-type'})
        assert response.status == 204, f'CORS preflight: HTTP {response.status}'
        assert response.headers.get('Access-Control-Allow-Origin') == origin
        await response.read()
    response = await client.get('/api/voices', headers=headers)
    assert response.status == 200, f'Voice catalogue: HTTP {response.status}'
    if origin:
        assert response.headers.get('Access-Control-Allow-Origin') == origin
    voices = await response.json()
    british = [v['name'] for v in voices if v['locale'] == 'en-GB']
    assert british, 'No British English voices returned'
    print('British voices:', ', '.join(british))
    voice = 'en-GB-SoniaNeural' if 'en-GB-SoniaNeural' in british else british[0]
    response = await client.post('/api/speech', headers=headers, json={
        'text': 'Welcome to Reciter. Take a moment to listen, think, and remember.',
        'voice': voice, 'rate': 1,
    })
    assert response.status == 200, f'Synthesis: HTTP {response.status}'
    assert response.headers.get('Content-Type') == 'audio/mpeg'
    audio = await response.read()
    assert len(audio) > 1000
    print(f'Live synthesis passed: {voice}, {len(audio)} audio bytes.')


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', help='Deployed HTTPS service origin; omit to test the local Python app')
    parser.add_argument('--origin', help='Exact frontend origin to verify CORS')
    args = parser.parse_args()
    if args.url:
        parsed = urlsplit(args.url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            parser.error('--url must be an HTTPS origin without credentials, path or query.')
        token = os.environ.get('RECITER_ACCESS_KEY') or getpass.getpass('Render access key (hidden): ')
        if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', token):
            parser.error('Use the full cloud access key (32–128 URL-safe characters).')
        async with ClientSession(base_url=args.url.rstrip('/'), timeout=ClientTimeout(total=15),
                                 raise_for_status=False) as client:
            await check(client, token, args.origin)
    else:
        async with TestClient(TestServer(create_app('smoke-only', [args.origin] if args.origin else []))) as client:
            await check(client, 'smoke-only', args.origin)


if __name__ == '__main__':
    asyncio.run(main(), loop_factory=create_server_loop)
