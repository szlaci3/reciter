import unittest
from aiohttp.test_utils import AioHTTPTestCase
from server import create_app


class ServiceTest(AioHTTPTestCase):
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

        return create_app('test-key', ['https://reciter.example'], FakeSpeech, voices)

    async def test_auth_cors_and_static_boundaries(self):
        response = await self.client.get('/api/voices')
        self.assertEqual(response.status, 401)
        response = await self.client.get('/api/voices', headers={'Authorization': 'Bearer test-key', 'Origin': 'https://bad.example'})
        self.assertEqual(response.status, 403)
        response = await self.client.options('/api/speech', headers={'Origin': 'https://reciter.example'})
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://reciter.example')
        for path in ('/server.py', '/.reciter-token', '/requirements.txt'):
            self.assertEqual((await self.client.get(path)).status, 404)
        self.assertEqual((await self.client.get('/')).status, 200)

    async def test_voice_validation_and_audio_cache(self):
        headers = {'Authorization': 'Bearer test-key'}
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
