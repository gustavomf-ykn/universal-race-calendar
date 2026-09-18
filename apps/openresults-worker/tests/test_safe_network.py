import pytest
from app.services.safe_network import bounded_get,public_ip
from app.models import RequestFailedError,URLValidationError
from worker import excel_cell


@pytest.mark.asyncio
async def test_dns_rejects_mixed_public_private_answers(monkeypatch):
    import asyncio
    async def addresses(*args,**kwargs):return [(2,1,6,'',('8.8.8.8',443)),(2,1,6,'',('127.0.0.1',443))]
    monkeypatch.setattr(asyncio.get_running_loop(),'getaddrinfo',addresses)
    with pytest.raises(URLValidationError):await public_ip('openresults.run')


@pytest.mark.asyncio
async def test_pins_ip_preserves_tls_name_and_bounds_body(monkeypatch):
    import app.services.safe_network as network
    async def address(host):return '8.8.8.8'
    monkeypatch.setattr(network,'public_ip',address)
    class Stream:
        status_code=200;headers={}
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def aiter_bytes(self):
            yield b'12345'
    class Client:
        def stream(self,method,url,headers,extensions):
            assert url.host=='8.8.8.8';assert headers['Host']=='openresults.run'
            assert extensions['sni_hostname']=='openresults.run'
            return Stream()
    with pytest.raises(RequestFailedError):await bounded_get(Client(),'https://openresults.run/',{},1,max_bytes=4)


def test_excel_cells_do_not_execute_formulas():
    assert excel_cell('=HYPERLINK("example")').startswith("'")
    assert excel_cell(' +SUM(1,1)').startswith("'")
    assert excel_cell('Ana')=='Ana'
