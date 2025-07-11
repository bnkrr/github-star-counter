// ==UserScript==
// @name         GitHub Repo Star Counter
// @namespace    http://tampermonkey.net/
// @version      1.6.5
// @description  Finds all GitHub repo links on a page and displays their star count.
// @author       bnkr & gemini.google
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      api.github.com
// ==/UserScript==

(function() {
    'use strict';

    // --- Default Settings ---
    const DEFAULTS = {
        githubToken: "",
        cacheEnabled: true,
        cacheDurationSeconds: 86400, // Default cache duration: 1 day
        maxCacheEntries: 1000,
        maxRetry: 3,
    };

    // --- Load or initialize configuration (Synchronous) ---
    const CONFIG_KEY = 'gh_star_config';
    let config = GM_getValue(CONFIG_KEY, DEFAULTS);

    // --- Dynamically calculated constants ---
    // Note: This will be recalculated when config changes.
    let CACHE_DURATION_MS = config.cacheDurationSeconds * 1000;

    const CACHE_PREFIX = 'gh_star_';
    const CACHE_MANIFEST_KEY = 'gh_star_cache_manifest';

    // --- Style Definitions ---
    GM_addStyle(`
        .gh-star-count-badge {
            display: inline-flex; align-items: center; margin-left: 6px;
            padding: 2px 6px; font-size: 12px; font-weight: 600;
            line-height: 1; color: #24292e; background-color: #eee;
            border-radius: 3px; text-decoration: none;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
        }
        .gh-star-count-badge:hover { background-color: #ddd; text-decoration: none; }
        .gh-star-count-badge .star-icon { color: #f9a825; margin-right: 3px; }

        /* --- Settings Panel Styles --- */
        #ghs-settings-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background-color: rgba(0, 0, 0, 0.6); z-index: 99998;
            display: flex; align-items: center; justify-content: center;
            font-family: sans-serif;
        }
        #ghs-settings-panel {
            background-color: #fff; color: #333; padding: 25px; border-radius: 8px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.3); width: 90%; max-width: 500px;
            z-index: 99999;
        }
        #ghs-settings-panel h2 {
            margin-top: 0; margin-bottom: 20px; font-size: 22px; color: #111;
            border-bottom: 1px solid #ddd; padding-bottom: 10px;
        }
        .ghs-setting { margin-bottom: 18px; }
        .ghs-setting label { display: block; margin-bottom: 6px; font-weight: bold; font-size: 14px; }
        .ghs-setting input[type="text"],
        .ghs-setting input[type="password"],
        .ghs-setting input[type="number"] {
            width: 100%; padding: 10px; border: 1px solid #ccc;
            border-radius: 4px; box-sizing: border-box; font-size: 14px;
        }
        .ghs-setting input[type="checkbox"] { margin-right: 8px; vertical-align: middle; width: 16px; height: 16px; }
        .ghs-setting .checkbox-label { vertical-align: middle; }
        .ghs-setting small { display: block; font-size: 12px; color: #666; margin-top: 5px; }
        .ghs-buttons { text-align: right; margin-top: 25px; }
        .ghs-buttons button {
            display: inline-flex; align-items: center; justify-content: center;
            padding: 10px 18px; border: none; border-radius: 5px;
            cursor: pointer; font-weight: bold; margin-left: 10px;
            transition: background-color 0.2s, box-shadow 0.2s;
        }
        #ghs-save-btn { background-color: #28a745; color: white; }
        #ghs-save-btn:hover { background-color: #218838; box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
        #ghs-cancel-btn { background-color: #ccc; color: #333; }
        #ghs-cancel-btn:hover { background-color: #bbb; }
    `);

    // --- Cache Management ---
    const cache = {
        get: (key) => {
            if (!config.cacheEnabled) return null;
            const manifest = GM_getValue(CACHE_MANIFEST_KEY, {});
            const entry = manifest[key];
            // Use the dynamically updated CACHE_DURATION_MS
            if (entry && (Date.now() - entry.timestamp < CACHE_DURATION_MS)) {
                const value = GM_getValue(CACHE_PREFIX + key, null);
                return value !== null ? { stars: value } : null;
            }
            return null;
        },
        set: (key, value) => {
            if (!config.cacheEnabled) return;
            const manifest = GM_getValue(CACHE_MANIFEST_KEY, {});
            manifest[key] = { timestamp: Date.now() };
            GM_setValue(CACHE_MANIFEST_KEY, manifest);
            GM_setValue(CACHE_PREFIX + key, value.stars);
        },
        prune: () => {
            if (!config.cacheEnabled) return;
            console.log('[GitHub Star Counter] Pruning cache...');
            let manifest = GM_getValue(CACHE_MANIFEST_KEY, {});
            let needsUpdate = false;
            const now = Date.now();
            let entries = Object.entries(manifest);
            for (const [key, value] of entries) {
                if (now - value.timestamp > CACHE_DURATION_MS) {
                    delete manifest[key];
                    GM_deleteValue(CACHE_PREFIX + key);
                    needsUpdate = true;
                }
            }
            entries = Object.entries(manifest);
            if (entries.length > config.maxCacheEntries) {
                entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
                const toRemoveCount = entries.length - config.maxCacheEntries;
                for (let i = 0; i < toRemoveCount; i++) {
                    const keyToRemove = entries[i][0];
                    delete manifest[keyToRemove];
                    GM_deleteValue(CACHE_PREFIX + keyToRemove);
                    needsUpdate = true;
                }
            }
            if (needsUpdate) {
                GM_setValue(CACHE_MANIFEST_KEY, manifest);
                console.log('[GitHub Star Counter] Cache pruned.');
            }
        }
    };

    // --- Helper function: Format star count ---
    function formatStars(num) {
        if (num >= 1000) {
            return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        }
        return num.toString();
    }

    // --- Core logic: Fetch and display star count ---
    function fetchAndDisplayStars(repoPath, elements, retries = 0) {
        const cachedData = cache.get(repoPath);
        if (cachedData) {
            addStarBadge(elements, cachedData.stars, repoPath);
            return;
        }

        console.log(`[GitHub Star Counter] Fetching from API for ${repoPath} (Attempt ${retries + 1})`);
        const apiUrl = `https://api.github.com/repos/${repoPath}`;
        const headers = {};
        if (config.githubToken) {
            headers.Authorization = `token ${config.githubToken}`;
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: apiUrl,
            headers: headers,
            onload: function(response) {
                if (response.status === 200) {
                    const data = JSON.parse(response.responseText);
                    const stars = data.stargazers_count;
                    addStarBadge(elements, stars, repoPath);
                    cache.set(repoPath, { stars });
                } else if (retries < config.maxRetry) {
                    console.warn(`[GitHub Star Counter] Failed to fetch ${repoPath}, status: ${response.status}. Retrying...`);
                    setTimeout(() => fetchAndDisplayStars(repoPath, elements, retries + 1), 1000 * (retries + 1));
                } else {
                    console.error(`[GitHub Star Counter] Failed to fetch data for ${repoPath} after all attempts.`);
                    markAsFailed(elements);
                }
            },
            onerror: function(error) {
                if (retries < config.maxRetry) {
                    console.warn(`[GitHub Star Counter] Network error while fetching ${repoPath}. Retrying...`);
                    setTimeout(() => fetchAndDisplayStars(repoPath, elements, retries + 1), 1000 * (retries + 1));
                } else {
                    console.error(`[GitHub Star Counter] Error fetching data for ${repoPath} after all attempts:`, error);
                    markAsFailed(elements);
                }
            }
        });
    }

    function markAsFailed(elements) {
        elements.forEach(el => el.dataset.ghStarsProcessed = 'failed');
    }

    function addStarBadge(elements, stars, repoPath) {
        const formattedStars = formatStars(stars);
        const starLinkHref = `https://github.com/${repoPath}/stargazers`;
        elements.forEach(el => {
            if (el.nextElementSibling && el.nextElementSibling.classList.contains('gh-star-count-badge')) {
                el.dataset.ghStarsProcessed = 'done';
                return;
            }
            const badge = document.createElement('a');
            badge.href = starLinkHref;
            badge.target = '_blank';
            badge.rel = 'noopener noreferrer';
            badge.className = 'gh-star-count-badge';
            badge.title = `${stars.toLocaleString()} stars`;
            badge.innerHTML = `<span class="star-icon">⭐</span>${formattedStars}`;
            el.insertAdjacentElement('afterend', badge);
            el.dataset.ghStarsProcessed = 'done';
        });
    }

    // --- Find links on the page ---
    function processLinks() {
        const links = document.querySelectorAll('a[href*="github.com/"]:not([data-gh-stars-processed])');
        const repoRegex = /^https?:\/\/github\.com\/([a-zA-Z0-9-]+\/[a-zA-Z0-9-._]+)(?:\/)?$/;
        const reposToFetch = new Map();
        links.forEach(link => {
            link.dataset.ghStarsProcessed = 'processing';
            const match = link.href.match(repoRegex);
            if (match) {
                const repoPath = match[1];
                if (!reposToFetch.has(repoPath)) reposToFetch.set(repoPath, []);
                reposToFetch.get(repoPath).push(link);
            } else {
                link.dataset.ghStarsProcessed = 'ignored';
            }
        });
        for (const [repoPath, elements] of reposToFetch.entries()) {
            fetchAndDisplayStars(repoPath, elements);
        }
    }

    // --- Initialization and Dynamic Content Monitoring ---
    function initialize() {
        GM_registerMenuCommand('GitHub Star Counter Settings', () => {
            document.getElementById('ghs-settings-overlay')?.remove();

            const uiHTML = `
                <div id="ghs-settings-overlay">
                    <div id="ghs-settings-panel">
                        <h2>GitHub Star Counter Settings</h2>
                        <div class="ghs-setting">
                            <label for="ghs-token">GitHub Personal Access Token (PAT)</label>
                            <input type="password" id="ghs-token" placeholder="Leave blank for anonymous access (lower rate-limit)">
                            <small>Increases API rate limit. Only <code>public_repo</code> scope is needed.</small>
                        </div>
                        <hr style="border: none; border-top: 1px solid #eee; margin: 25px 0;">
                        <div class="ghs-setting">
                            <label>
                                <input type="checkbox" id="ghs-cache-enable">
                                <span class="checkbox-label">Enable Cache</span>
                            </label>
                            <small>Greatly reduces API requests to avoid rate-limiting.</small>
                        </div>
                        <div class="ghs-setting">
                            <label for="ghs-cache-duration">Cache Duration (seconds)</label>
                            <input type="number" id="ghs-cache-duration" min="1" step="1">
                        </div>
                        <div class="ghs-setting">
                            <label for="ghs-max-entries">Max Cache Entries</label>
                            <input type="number" id="ghs-max-entries" min="10" step="10">
                        </div>
                        <div class="ghs-buttons">
                            <button id="ghs-cancel-btn">Cancel</button>
                            <button id="ghs-save-btn">Save</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', uiHTML);

            const overlay = document.getElementById('ghs-settings-overlay');
            const saveBtn = document.getElementById('ghs-save-btn');
            const cancelBtn = document.getElementById('ghs-cancel-btn');

            const currentConfig = GM_getValue(CONFIG_KEY, DEFAULTS);
            document.getElementById('ghs-token').value = currentConfig.githubToken;
            document.getElementById('ghs-cache-enable').checked = currentConfig.cacheEnabled;
            document.getElementById('ghs-cache-duration').value = currentConfig.cacheDurationSeconds;
            document.getElementById('ghs-max-entries').value = currentConfig.maxCacheEntries;

            const closeAndDestroyUI = () => {
                overlay.remove();
            };

            saveBtn.addEventListener('click', () => {
                const newConfig = {
                    githubToken: document.getElementById('ghs-token').value.trim(),
                    cacheEnabled: document.getElementById('ghs-cache-enable').checked,
                    cacheDurationSeconds: parseInt(document.getElementById('ghs-cache-duration').value, 10) || DEFAULTS.cacheDurationSeconds,
                    maxCacheEntries: parseInt(document.getElementById('ghs-max-entries').value, 10) || DEFAULTS.maxCacheEntries,
                    maxRetry: currentConfig.maxRetry,
                };

                // 1. Save the new configuration to storage
                GM_setValue(CONFIG_KEY, newConfig);

                // 2. Update the script's currently running config object
                config = newConfig;

                // 3. Recalculate derived variables
                CACHE_DURATION_MS = config.cacheDurationSeconds * 1000;

                alert('Settings saved.');
                closeAndDestroyUI();
            });

            cancelBtn.addEventListener('click', closeAndDestroyUI);
        });

        cache.prune();
        processLinks();
        const observer = new MutationObserver(() => {
            if (observer.timeout) clearTimeout(observer.timeout);
            observer.timeout = setTimeout(processLinks, 500);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    initialize();

})();
