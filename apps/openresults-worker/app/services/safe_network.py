"""Public DNS resolution and bounded HTTP reads with the resolved IP pinned."""
import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

import httpx
from app.models import URLValidationError, RequestFailedError


async def public_ip(host):
    async with asyncio.timeout(10):
        records=await asyncio.get_running_loop().getaddrinfo(host,443,type=socket.SOCK_STREAM)
    addresses=sorted({record[4][0] for record in records})
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise URLValidationError('O destino DNS não é público.')
    return addresses[0]


async def bounded_get(client,url,headers,timeout,max_bytes=10*1024*1024):
    parsed=urlsplit(url)
    async with asyncio.timeout(timeout):
        address=await public_ip(parsed.hostname)
        # Keep the original Host header and TLS SNI/certificate hostname while
        # connecting to the exact validated address; redirects are handled upstream.
        request_url=httpx.URL(url).copy_with(host=address)
        async with client.stream('GET',request_url,headers={**headers,'Host':parsed.hostname},
                                 extensions={'sni_hostname':parsed.hostname}) as response:
            body=bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body)>max_bytes:
                    raise RequestFailedError('Resposta excede o limite permitido.')
            safe_headers={k:v for k,v in response.headers.items() if k.lower() not in ('content-encoding','content-length')}
            return httpx.Response(response.status_code,headers=safe_headers,content=bytes(body),request=httpx.Request('GET',url))
