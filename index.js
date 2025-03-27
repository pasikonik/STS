const express = require('express');
const puppeteer = require('puppeteer');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const path = require('path');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Path for storing login state
const COOKIES_PATH = path.resolve(__dirname, 'spotify-cookies.json');
const STATE_PATH = path.resolve(__dirname, 'spotify-login-state.json');


class SpotifyAuthManager {
    static async checkLoginState() {
        try {
            // Check if state file exists
            const stateExists = await fs.access(STATE_PATH)
                .then(() => true)
                .catch(() => false);

            if (!stateExists) {
                return false;
            }

            // Read state file
            const stateData = await fs.readFile(STATE_PATH, 'utf8');
            const loginState = JSON.parse(stateData);

            // Check if state is still valid (e.g., within 7 days)
            const currentTime = Date.now();
            return (currentTime - loginState.timestamp) < (7 * 24 * 60 * 60 * 1000);
        } catch (error) {
            console.error('Error checking login state:', error);
            return false;
        }
    }

    static async saveLoginState() {
        const stateData = {
            timestamp: Date.now()
        };

        await fs.writeFile(STATE_PATH, JSON.stringify(stateData), 'utf8');
    }

    static async saveCookies(page) {
        const cookies = await page.cookies();
        await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies), 'utf8');
    }

    static async loadCookies(page) {
        try {
            const cookiesString = await fs.readFile(COOKIES_PATH, 'utf8');
            const cookies = JSON.parse(cookiesString);
            await page.setCookie(...cookies);
            return true;
        } catch (error) {
            console.error('Error loading cookies:', error);
            return false;
        }
    }

    static async performLogin(page) {
        // Navigate to Spotify login page
        await page.goto('https://accounts.spotify.com/login', {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        // Wait for username input and type slowly
        await page.waitForSelector('#login-username', { visible: true });
        await page.type('#login-username', process.env.SPOTIFY_EMAIL, { delay: 100 });

        // Wait for password input and type slowly
        await page.waitForSelector('#login-password', { visible: true });
        await page.type('#login-password', process.env.SPOTIFY_PASSWORD, { delay: 100 });

        // Click login button with wait
        await page.click('#login-button');

        // Wait for navigation and potential challenges
        await page.waitForNavigation({
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        // Save cookies and login state
        await this.saveCookies(page);
        await this.saveLoginState();
    }

    static async verifyLogin(page) {
        try {
            // Check for user widget or logged-in state indicator
            await page.waitForSelector('[data-testid="user-widget-link"]', { timeout: 10000 });
            return true;
        } catch {
            return false;
        }
    }
}

app.get('/transcript/:episodeId', async (req, res) => {
    const { episodeId } = req.params;

    let browser;
    try {
        // Launch browser 
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ],
            defaultViewport: null
        });

        const page = await browser.newPage();

        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        // Increase timeout
        await page.setDefaultTimeout(60000);

        // Check if already logged in via cached state
        const isLoggedInState = await SpotifyAuthManager.checkLoginState();

        if (isLoggedInState) {
            // Try to load cookies
            const cookiesLoaded = await SpotifyAuthManager.loadCookies(page);

            // Navigate to episode page
            await page.goto(`https://open.spotify.com/episode/${episodeId}`, {
                waitUntil: 'networkidle0',
                timeout: 60000
            });

            // Verify login is still valid
            const isLoginValid = await SpotifyAuthManager.verifyLogin(page);

            if (!isLoginValid || !cookiesLoaded) {
                // Perform full login if cookies are invalid
                await SpotifyAuthManager.performLogin(page);
            }
        } else {
            // Perform full login
            await SpotifyAuthManager.performLogin(page);
        }

        // Wait for transcript tab and click
        await page.evaluate(() => {
            const transcriptTabs = Array.from(document.querySelectorAll('a'))
                .filter(button => button.textContent.toLowerCase().includes('transcript'));

            if (transcriptTabs.length > 0) {
                transcriptTabs[0].click();
                console.log('After click Transcript tab ');
            } else {
                console.error('Transcript tab not found');
            }
        });

        // Wait for transcript container
        await page.waitForSelector('div[class^="NavBar__NavBarPage"]', { timeout: 30000 });
        console.log('Transcript container found');

        // Extract transcript text
        const transcriptText = await page.evaluate(() => {
            const transcriptSegments = document.querySelectorAll('div[class^="NavBar__NavBarPage"] > div:not(:first-child)');

            if (!transcriptSegments) {
                return null;
            }

            const mergedText = Array.from(transcriptSegments)
                .map(div => {
                    const timeStamp = div.querySelector('span[data-encore-id="text"]')?.textContent.trim();
                    const textContent = div.querySelector('span[dir="auto"]')?.textContent.trim();
                    return timeStamp && textContent ? `${timeStamp}\n${textContent}` : '';
                })
                .filter(text => text !== '')
                .join('\n\n');

            return mergedText;
        });

        // Send transcript as response
        if (transcriptText) {
            res.json({
                episodeId,
                transcript: transcriptText
            });
        } else {
            res.status(404).json({
                error: 'Transcript not found'
            });
        }

    } catch (error) {
        console.error('Transcript retrieval error:', error);
        res.status(500).json({
            error: 'Failed to retrieve transcript',
            details: error.message
        });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Transcript retrieval service running on port ${PORT}`);
});