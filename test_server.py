import unittest
import asyncio
import sys
from unittest.mock import AsyncMock, patch
from pathlib import Path
from tempfile import TemporaryDirectory
from aiohttp.test_utils import AioHTTPTestCase
from server import create_app, load_access_key, create_server_loop, console_wakeup, FRONTEND


class AccessKeyTest(unittest.TestCase):
    def test_new_and_legacy_keys_are_four_letters_and_persist(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / '.reciter-token'
            for legacy in (None, 'old-long-access-token'):
                if legacy is not None:
                    path.write_text(legacy, encoding='utf-8')
                token = load_access_key(path)
                self.assertRegex(token, r'^[a-z]{4}$')
                self.assertEqual(load_access_key(path), token)


class ConsoleWakeupTest(unittest.IsolatedAsyncioTestCase):
    async def test_wakeup_interval_and_cancellation_on_cleanup(self):
        before = asyncio.all_tasks()
        context = console_wakeup(None)
        await anext(context)
        created = asyncio.all_tasks() - before
        self.assertEqual(len(created), 1)
        task = created.pop()
        with patch('server.asyncio.sleep', new_callable=AsyncMock) as sleep:
            # A blocked sleep lets us inspect the scheduled interval, then
            # cleanup must cancel that wait without leaving a background task.
            gate = asyncio.Event()
            started = asyncio.Event()

            async def wait(delay):
                started.set()
                await gate.wait()

            sleep.side_effect = wait
            await asyncio.wait_for(started.wait(), timeout=1)
            sleep.assert_awaited_once_with(0.25)
            await context.aclose()
        self.assertTrue(task.cancelled())

    async def test_wakeup_is_installed_only_on_windows(self):
        for platform in ('win32', 'linux'):
            with patch('server.sys.platform', platform):
                app = create_app('test')
            self.assertEqual(console_wakeup in app.cleanup_ctx, platform == 'win32')


class ServiceTest(AioHTTPTestCase):
    loop_factory = staticmethod(create_server_loop)

    async def test_disconnected_client_does_not_prevent_next_request(self):
        if sys.platform == 'win32':
            self.assertIsInstance(asyncio.get_running_loop(), asyncio.SelectorEventLoop)
        address = self.server.make_url('/')
        _, writer = await asyncio.open_connection(address.host, address.port)
        writer.write(b'GET /api/voices HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer abcd\r\n\r\n')
        await writer.drain()
        writer.transport.abort()
        await writer.wait_closed()
        response = await self.client.get('/api/voices', headers={'Authorization': 'Bearer abcd'})
        self.assertEqual(response.status, 200)
        response = await self.client.post('/api/speech', headers={'Authorization': 'Bearer abcd'},
                                          json={'text': 'New text after disconnect.', 'voice': 'en-GB-SoniaNeural', 'rate': 1})
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), b'fake-mp3')

    async def get_application(self):
        self.generated = 0
        owner = self

        class FakeSpeech:
            def __init__(self, *args, **kwargs):
                pass

            async def stream(self):
                owner.generated += 1
                yield {'type': 'audio', 'data': b'fake-mp3'}

        async def voices():
            return [{'ShortName': 'en-GB-SoniaNeural', 'Locale': 'en-GB', 'Gender': 'Female'}]

        return create_app('abcd', ['https://reciter.example'], FakeSpeech, voices)

    async def test_auth_cors_and_static_boundaries(self):
        response = await self.client.get('/api/voices')
        self.assertEqual(response.status, 401)
        response = await self.client.get('/api/voices', headers={'Authorization': 'Bearer wrong'})
        self.assertEqual(response.status, 401)
        response = await self.client.get('/api/voices', headers={'Authorization': 'Bearer abcd', 'Origin': 'https://bad.example'})
        self.assertEqual(response.status, 403)
        response = await self.client.options('/api/speech', headers={'Origin': 'https://reciter.example'})
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://reciter.example')
        for path in ('/server.py', '/.reciter-token', '/requirements.txt', '/library.test.js',
                     '/package.json', '/node_modules/dexie/dist/dexie.js'):
            self.assertEqual((await self.client.get(path)).status, 404)
        self.assertEqual((await self.client.get('/')).status, 200)
        for name in FRONTEND:
            self.assertEqual((await self.client.get('/' + name)).status, 200, name)
        for path in ('/dexie.js?v=4.4.6-diag2', '/library.js?v=1'):
            response = await self.client.get(path)
            self.assertEqual(response.status, 200)
            self.assertIn('javascript', response.headers['Content-Type'])
            local = Path(__file__).parent / path.split('?')[0].lstrip('/')
            self.assertEqual(await response.read(), local.read_bytes())

    async def test_voice_validation_and_audio_cache(self):
        headers = {'Authorization': 'Bearer abcd'}
        self.assertEqual((await self.client.get('/api/voices', headers=headers)).status, 200)
        payload = {'text': 'Remember this.', 'voice': 'en-GB-SoniaNeural', 'rate': 1}
        for _ in range(2):
            response = await self.client.post('/api/speech', json=payload, headers=headers)
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers['Content-Type'], 'audio/mpeg')
            self.assertEqual(await response.read(), b'fake-mp3')
        self.assertEqual(self.generated, 1)
        for field, value in [('text', ''), ('text', 'x' * 2001), ('voice', 'unknown'), ('rate', 10)]:
            response = await self.client.post('/api/speech', json={**payload, field: value}, headers=headers)
            self.assertEqual(response.status, 400)


if __name__ == '__main__':
    unittest.main()
