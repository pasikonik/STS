import express from 'express';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import morgan from 'morgan';
import { createClient } from 'redis';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

app.use(morgan(':remote-addr :method :url :status :res[content-length] - :response-time ms'));

const COOKIES_PATH = path.resolve(__dirname, 'spotify-cookies.json');
const STATE_PATH = path.resolve(__dirname, 'spotify-login-state.json');

const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => console.error('Redis Client Error:', err));

(async () => {
    await redisClient.connect();
    console.log('Redis client connected');
})();

class SpotifyAuthManager {
    static async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    static async checkLoginState() {
        if (!(await this.fileExists(STATE_PATH))) return false;

        try {
            const stateData = await fs.readFile(STATE_PATH, 'utf8');
            const { timestamp } = JSON.parse(stateData);
            const isValid = (Date.now() - timestamp) < 7 * 24 * 60 * 60 * 1000;
            console.log(`Login state valid: ${isValid}`);
            return isValid;
        } catch (err) {
            console.error('Failed to read login state:', err);
            return false;
        }
    }

    static async saveLoginState() {
        try {
            await fs.writeFile(STATE_PATH, JSON.stringify({ timestamp: Date.now() }), 'utf8');
            console.log('Cookies saved');
        } catch (err) {
            console.error('Error loading cookies:', err);
            return false;
        }
    }

    static async saveCookies(page) {
        try {
            console.log('Attempting login to Spotify...');
            const cookies = await page.cookies();
            await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies), 'utf8');
        } catch (err) {
            console.error('Failed to save cookies:', err);
        }
    }

    static async loadCookies(page) {
        if (!(await this.fileExists(COOKIES_PATH))) return false;

        try {
            const cookies = JSON.parse(await fs.readFile(COOKIES_PATH, 'utf8'));
            await page.setCookie(...cookies);
            return true;
        } catch (err) {
            console.error('Error loading cookies:', err);
            return false;
        }
    }

    static async performLogin(page) {
        try {
            console.log('Attempting login to Spotify...');
            await page.goto('https://accounts.spotify.com/login', {
                waitUntil: 'networkidle0',
                timeout: 60000
            });

            await page.waitForSelector('#login-username', { visible: true });
            await page.type('#login-username', process.env.SPOTIFY_EMAIL);

            await page.waitForSelector('#login-password', { visible: true });
            await page.type('#login-password', process.env.SPOTIFY_PASSWORD);

            await Promise.all([
                page.click('#login-button'),
                page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 })
            ]);

            await this.saveCookies(page);
            await this.saveLoginState();
            console.log('Login successful');
        } catch (err) {
            throw new Error('Login failed: ' + err.message);
        }
    }

    static async ensureLoggedIn(page, episodeId) {
        const isValidState = await this.checkLoginState();
        const cookiesLoaded = isValidState && await this.loadCookies(page);

        try {
            console.log(`Navigating to episode page: ${episodeId}`);
            await page.goto(`https://open.spotify.com/episode/${episodeId}`, {
                waitUntil: 'networkidle0',
                timeout: 60000
            });

            const isStillLoggedIn = await this.verifyLogin(page);
            if (!isStillLoggedIn || !cookiesLoaded) {
                await this.performLogin(page);
                await page.goto(`https://open.spotify.com/episode/${episodeId}`, {
                    waitUntil: 'networkidle0',
                    timeout: 60000
                });
            }
        } catch (err) {
            throw new Error('Login verification failed: ' + err.message);
        }
    }

    static async verifyLogin(page) {
        try {
            await page.waitForSelector('[data-testid="user-widget-link"]', { timeout: 10000 });
            return true;
        } catch {
            return false;
        }
    }
}

app.get('/', async (req, res) => {
    res.send('Serwer STS działa poprawnie ✔️');
});

app.get('/transcript/:episodeId', async (req, res) => {
    const { episodeId } = req.params;
    const redisKey = `transcript:${episodeId}`;
    let browser;

    try {
        console.log(`Request received for episode: ${episodeId}`);
        // STEP 1: Check cache
        const cachedTranscript = await redisClient.get(redisKey);
        if (cachedTranscript) {
            console.log(`Cache hit for episode ${episodeId}`);
            return res.json({
                episodeId,
                transcript: cachedTranscript,
                source: 'cache'
            });
        }

        console.log(`Cache miss for episode ${episodeId}. Launching Puppeteer...`);
        // STEP 2: Launch Puppeteer
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--mute-audio',
                '--disable-dev-shm-usage',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-sync',
            ],
            timeout: 10000
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        page.setDefaultTimeout(60000);

        await SpotifyAuthManager.ensureLoggedIn(page, episodeId);

        const clickedTranscript = await page.evaluate(() => {
            const tab = Array.from(document.querySelectorAll('a')).find(el =>
                el.textContent.toLowerCase().includes('transcript'));
            if (tab) {
                tab.click();
                return true;
            }
            return false;
        });

        if (!clickedTranscript) {
            console.warn('Transcript tab not found');
            return res.status(404).json({ error: 'Transcript tab not found' });
        }

        await page.waitForSelector('div[class^="NavBar__NavBarPage"]', { timeout: 10000 });

        const transcript = await page.evaluate(() => {
            const container = document.querySelector('div[class^="NavBar__NavBarPage"]');
            if (!container) return null;

            return Array.from(container.querySelectorAll('div:not(:first-child)'))
                .map(div => {
                    const time = div.querySelector('span[data-encore-id="text"]')?.textContent.trim();
                    const text = div.querySelector('span[dir="auto"]')?.textContent.trim();
                    return time && text ? `${time}\n${text}` : null;
                })
                .filter(Boolean)
                .join('\n\n');
        });

        if (!transcript) {
            console.warn('Transcript not found or empty');
            return res.status(404).json({ error: 'Transcript not found or empty' });
        }

        // STEP 3: Cache it in Redis for 24h
        await redisClient.set(redisKey, transcript, { EX: 60 * 60 * 24 });
        console.log(`Transcript cached for episode ${episodeId}`);

        return res.json({ episodeId, transcript, source: 'fresh' });

    } catch (err) {
        console.error('Transcript retrieval failed:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Transcript retrieval service running on port ${PORT}`);
});
