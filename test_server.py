import unittest
import asyncio
import sys
from unittest.mock import AsyncMock, patch
from pathlib import Path
from tempfile import TemporaryDirectory
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from aiohttp.test_utils import AioHTTPTestCase
from server import create_app, load_access_key, create_server_loop, console_wakeup, server_config, main, FRONTEND


CLOUD_KEY = 'AbCd_0123456789-xyz' * 3  # Test fixture only, never a deployed secret.


class PublicConfigTest(unittest.TestCase):
    def test_render_port_secret_and_exact_origins(self):
        config = server_config([], {'RENDER': 'true', 'PORT': '10000',
            'RECITER_ACCESS_KEY': CLOUD_KEY,
            'RECITER_ALLOWED_ORIGINS': 'https://reciter.example/, https://second.example'})
        self.assertTrue(config.public)
        self.assertEqual(config.token, CLOUD_KEY)
        self.assertEqual(config.port, 10000)
        self.assertEqual(config.host, '0.0.0.0')
        self.assertEqual(config.origin, ['https://reciter.example', 'https://second.example'])

    def test_public_mode_fails_closed_without_valid_configuration(self):
        valid = {'RECITER_ACCESS_KEY': CLOUD_KEY, 'RECITER_ALLOWED_ORIGINS': 'https://reciter.example'}
        cases = [{'RENDER': 'true'}, {},
                 {**valid, 'RECITER_ACCESS_KEY': 'abcd'},
                 {**valid, 'RECITER_ACCESS_KEY': 'x' * 129},
                 {**valid, 'RECITER_ACCESS_KEY': 'secret with spaces ' * 3},
                 {**valid, 'RECITER_ALLOWED_ORIGINS': ''},
                 {**valid, 'PORT': '0'}, {**valid, 'PORT': '65536'},
                 {**valid, 'PORT': 'invalid'}]
        for origin in ['*', 'http://reciter.example', 'https://*.example',
                       'https://reciter.example/path', 'https://user:password@reciter.example',
                       'https://reciter.example?query=1', 'https://reciter.example#fragment',
                       'https://reciter.example:invalid']:
            cases.append({**valid, 'RECITER_ALLOWED_ORIGINS': origin})
        for env in cases:
            with self.subTest(env_keys=list(env)), redirect_stderr(StringIO()) as errors:
                with self.assertRaises(SystemExit) as result:
                    server_config(['--public'], env)
                self.assertEqual(result.exception.code, 2)
                self.assertNotIn(CLOUD_KEY, errors.getvalue())
        with redirect_stderr(StringIO()), self.assertRaises(SystemExit):
            server_config([], {'RENDER': 'true'})

    def test_lan_defaults_and_explicit_port_still_work(self):
        config = server_config([], {})
        self.assertFalse(config.public)
        self.assertEqual(config.port, 8000)
        config = server_config(['--port', '9000', '--origin', 'http://phone.example'], {'PORT': '10000'})
        self.assertEqual(config.port, 9000)
        self.assertEqual(config.origin, ['http://phone.example'])

    def test_public_start_never_reads_local_key_or_prints_secret(self):
        config = server_config(['--public'], {'RECITER_ACCESS_KEY': CLOUD_KEY,
            'RECITER_ALLOWED_ORIGINS': 'https://reciter.example'})
        with patch('server.server_config', return_value=config), patch('server.load_access_key') as local_key, \
                patch('server.web.run_app') as run, patch('server.create_server_loop', return_value=None), \
                redirect_stdout(StringIO()) as output:
            main()
        local_key.assert_not_called()
        self.assertNotIn(CLOUD_KEY, output.getvalue())
        self.assertEqual(run.call_args.kwargs['host'], '0.0.0.0')
        self.assertIsNone(run.call_args.kwargs['access_log'])


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
                     '/package.json', '/node_modules/dexie/dist/dexie.js', '/render.yaml',
                     '/.env', '/check_deployment.py', '/DEPLOY-RENDER.md'):
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

    async def test_large_static_responses_preserve_bytes_without_sendfile(self):
        expected = (Path(__file__).parent / 'dexie.js').read_bytes()
        loop = asyncio.get_running_loop()

        async def download():
            response = await self.client.get('/dexie.js?v=4.4.6-diag2')
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers['X-Reciter-Static'], 'buffered-v1')
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(int(response.headers['Content-Length']), len(expected))
            chunks = []
            async for chunk in response.content.iter_chunked(4096):
                chunks.append(chunk)
                await asyncio.sleep(0)
            self.assertEqual(b''.join(chunks), expected)

        # Exercise interleaved large responses and prohibit the suspect transfer
        # path on all platforms, including Windows when the user runs this suite.
        with patch.object(loop, 'sendfile', new_callable=AsyncMock) as sendfile:
            sendfile.side_effect = AssertionError('Static assets must bypass sendfile')
            await asyncio.gather(*(download() for _ in range(6)))
            sendfile.assert_not_awaited()

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


class CloudServiceTest(AioHTTPTestCase):
    async def get_application(self):
        self.voices = AsyncMock(return_value=[{'ShortName': 'en-GB-SoniaNeural', 'Locale': 'en-GB', 'Gender': 'Female'}])
        return create_app(CLOUD_KEY, ['https://reciter.example'], list_voices=self.voices)

    async def test_health_is_public_and_does_not_contact_microsoft(self):
        response = await self.client.get('/healthz')
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {'status': 'ok'})
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual((await self.client.head('/healthz')).status, 200)
        self.voices.assert_not_awaited()

    async def test_cloud_key_is_required_and_cors_works_behind_https_proxy(self):
        for key in ['', 'abcd', CLOUD_KEY.lower(), 'non-ascii-\u00e9']:
            response = await self.client.get('/api/voices', headers={'Authorization': 'Bearer ' + key})
            self.assertEqual(response.status, 401)
        self.voices.assert_not_awaited()
        response = await self.client.options('/api/speech', headers={
            'Origin': 'https://reciter.example', 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization,content-type'})
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://reciter.example')
        response = await self.client.get('/api/voices', headers={
            'Authorization': 'Bearer ' + CLOUD_KEY, 'Origin': 'https://reciter.example'})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://reciter.example')
        self.voices.assert_awaited_once()
        response = await self.client.get('/api/voices', headers={'Authorization': 'Bearer ' + CLOUD_KEY,
            'Origin': 'https://unapproved.example', 'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'unapproved.example'})
        self.assertEqual(response.status, 403)


class DeploymentSmokeTest(AioHTTPTestCase):
    async def get_application(self):
        owner = self
        self.texts = []

        class FakeSpeech:
            def __init__(self, text, *args, **kwargs):
                owner.texts.append(text)

            async def stream(self):
                yield {'type': 'audio', 'data': b'x' * 2048}

        voices = AsyncMock(return_value=[{'ShortName': 'en-GB-SoniaNeural', 'Locale': 'en-GB', 'Gender': 'Female'}])
        return create_app(CLOUD_KEY, ['https://reciter.example'], FakeSpeech, voices)

    async def test_deployment_checker_checks_real_http_routes_with_fake_upstream(self):
        from live_smoke import check
        with redirect_stdout(StringIO()) as output:
            await check(self.client, CLOUD_KEY, 'https://reciter.example')
        self.assertEqual(self.texts, ['Welcome to Reciter. Take a moment to listen, think, and remember.'])
        self.assertIn('2048 audio bytes', output.getvalue())
        self.assertNotIn(CLOUD_KEY, output.getvalue())


if __name__ == '__main__':
    unittest.main()
