"""Explicit live check: sends only the sample below to Microsoft, never user text."""
import asyncio
from aiohttp.test_utils import TestClient, TestServer
from server import create_app, create_server_loop


async def main():
    async with TestClient(TestServer(create_app('smoke-only'))) as client:
        headers = {'Authorization': 'Bearer smoke-only'}
        response = await client.get('/api/voices', headers=headers)
        assert response.status == 200, await response.text()
        voices = await response.json()
        british = [v['name'] for v in voices if v['locale'] == 'en-GB']
        print('British voices:', ', '.join(british))
        voice = 'en-GB-SoniaNeural' if 'en-GB-SoniaNeural' in british else british[0]
        response = await client.post('/api/speech', headers=headers, json={
            'text': 'Welcome to Reciter. Take a moment to listen, think, and remember.',
            'voice': voice, 'rate': 1,
        })
        assert response.status == 200, await response.text()
        audio = await response.read()
        assert len(audio) > 1000
        print(f'Live synthesis passed: {voice}, {len(audio)} audio bytes.')


asyncio.run(main(), loop_factory=create_server_loop)
