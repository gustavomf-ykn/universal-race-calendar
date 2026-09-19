"""Offline browser smoke: launches the real installed Chromium as the image user."""
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as playwright:
        browser=await playwright.chromium.launch(headless=True)
        try:
            page=await browser.new_page()
            await page.set_content('<title>race-platform-browser-smoke</title>')
            assert await page.title()=='race-platform-browser-smoke'
            assert await page.evaluate('6 * 7')==42
            print('chromium_launch_dom_javascript_passed')
        finally:
            await browser.close()

if __name__=='__main__':asyncio.run(main())
