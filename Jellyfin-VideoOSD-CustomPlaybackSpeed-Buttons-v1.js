(function () {
    'use strict';

    // ---- PLUGIN ADAPTER: config source (VideoOSD Tweaks and Candy) ----

    const CONFIG = {
        // ============================================================
        // == SHARED VALUE (both standalone and plugin usage) ==
        // Standalone: true hides the buttons on narrow windows
        // (max-width 50em), see refreshResponsiveStyle().
        // Plugin: overwritten by applyPluginConfig() with the
        // admin's "Hide on Narrow Window" setting once fetched.
        // ============================================================
        hideOnNarrowWindow: true,

        // ============================================================
        // == SHARED VALUE, correct for both cases here ==
        // Per-addon gap override from the plugin; 0 = no extra gap,
        // which is also the standalone default. The gap itself is
        // applied by the Core script, see applySpacing() below.
        // ============================================================
        centeredGapEm: 0
    };

    async function fetchPluginConfig() {
        const maxAttempts = 120;
        const delayMs = 250;
        let failures = 0;
        // Declared outside the loop: a function created inside it that reads
        // 'failures' makes linters (JavaScript Injector's editor) warn.
        function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // No ApiClient yet (jellyfin-web creates it once a server is
            // known, e.g. after the server selection page): wait without
            // using up an attempt, like the not-logged-in case below.
            if (!window.ApiClient) attempt--;
            if (window.ApiClient && typeof ApiClient.getJSON === 'function') {
                // Not logged in yet (e.g. still on the login page): every
                // request would only fail with 401, so wait without using up
                // an attempt.
                if (typeof ApiClient.accessToken === 'function' && !ApiClient.accessToken()) {
                    attempt--;
                    await wait(delayMs);
                    continue;
                }
                try {
                    // The plugin's own endpoint, readable for every signed-in user.
                    const config = await ApiClient.getJSON(ApiClient.getUrl('VideoOSDTweaksCandy/ClientConfiguration'));
                    if (config) return config;
                    throw new Error('empty configuration');
                } catch (err) {
                    // 403: no access; 404: plugin not installed (standalone
                    // use). Retrying can't change either, so stop and use
                    // the defaults instead of sending up to 120 failing
                    // requests.
                    if (err && (err.status === 403 || err.status === 404)) return null;
                    // Server error (5xx), network error or empty answer: at most 3
                    // retries, 0.5 / 1 / 2 s apart, then the defaults until the next
                    // fetch.
                    if (++failures > 3) return null;
                    await wait(delayMs * Math.pow(2, failures));
                    continue;
                }
            }
            await wait(delayMs);
        }
        return null;
    }

    function applyPluginConfig(pluginConfig) {
        if (!pluginConfig) return;

        if (typeof pluginConfig.SpeedHideOnNarrowWindow === 'boolean') {
            CONFIG.hideOnNarrowWindow = pluginConfig.SpeedHideOnNarrowWindow;
        }

        CONFIG.centeredGapEm = pluginConfig.SpeedIndividualCenteredGapOverride
            ? (Number(pluginConfig.SpeedCenteredGapValue) || 0)
            : (Number(pluginConfig.GeneralCenteredGap) || 0);
    }
    // ---- END PLUGIN ADAPTER ----

    const FALLBACK_SPEEDS = [
        0.5,
        0.75,
        1,
        1.25,
        1.5,
        1.75,
        2,
        2.5,
        3,
        3.5,
        4
    ];

    const ADDON_ID = 'jellyfin-speed-buttons';
    const ADDON_NAME = 'Speed Buttons';

    const CUSTOMS_API_NAME = 'JellyfinVideoOSDCustomsMenu';
    const CUSTOMS_WAIT_MS = 300;
    const CUSTOMS_WAIT_TRIES = 120;
    const CUSTOMS_STORAGE_KEY =
        CUSTOMS_API_NAME + '.addon.' + ADDON_ID;

    const BUTTON_CLASS = 'jfb-speed-step-button';
    const FIELD_CLASS = 'jfb-speed-step-field';
    const CONTAINER_CLASS = 'jfb-speed-step-container';
    const STYLE_ID = 'jfb-speed-step-style';
    const RESPONSIVE_STYLE_ID = 'jfb-speed-step-responsive-style';

    let enabled = false;
    let observer = null;
    let registeredWithCustoms = false;
    let customsRegisterTimer = null;



    let ignoreStoredCustomsState = false;

    function isCustomsAvailable() {
        const api = window[CUSTOMS_API_NAME];
        return !!api && typeof api.registerAddon === 'function';
    }

    function isEnabledByCustomsState() {
        return localStorage.getItem(CUSTOMS_STORAGE_KEY) !== 'false';
    }

    function stop(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    function getVideo() {
        return document.querySelector('video');
    }

    function getVideos() {
        return [...document.querySelectorAll('video')];
    }

    function getTransportBar() {
        return document.querySelector('#videoOsdPage:not(.hide) .buttons.focuscontainer-x > div[dir="ltr"]');
    }

    function getSpeedField() {
        return document.querySelector('#videoOsdPage:not(.hide) .' + FIELD_CLASS);
    }

    function getSpeeds() {
        const customSource =
            window.JellyfinCustomPlaybackSpeed &&
            window.JellyfinCustomPlaybackSpeed.SPEEDS;

        const source = (
            customSource &&
            Array.isArray(customSource) &&
            customSource.length
        )
            ? customSource
            : FALLBACK_SPEEDS;

        return source
            .map(Number)
            .filter(v => !Number.isNaN(v) && v >= 0.0625 && v <= 16)
            .sort((a, b) => a - b);
    }

    function updateSpeedField() {
        const video = getVideo();
        const field = getSpeedField();

        if (!field) return;

        const storedRate = Number(sessionStorage.getItem('playbackRateSpeed'));

        const rate = (
            video &&
            video.playbackRate !== 1
        )
            ? video.playbackRate
            : (
                !Number.isNaN(storedRate) &&
                storedRate >= 0.0625 &&
                storedRate <= 16
            )
                ? storedRate
                : video
                    ? video.playbackRate
                    : 1;

        field.value = rate + 'x';
    }

    function setSpeed(rate) {
        sessionStorage.setItem('playbackRateSpeed', String(rate));

        getVideos().forEach(video => {
            video.playbackRate = rate;
        });

        updateSpeedField();

    }

    function resetSpeed() {
        setSpeed(1);
    }

    function stepSpeed(direction) {
        const video = getVideo();
        if (!video) return;

        const speeds = getSpeeds();
        if (!speeds.length) return;

        const current = video.playbackRate || 1;
        const EPS = 0.0001;

        const next = direction < 0
            ? [...speeds].reverse().find(v => v < current - EPS) || speeds[0]
            : speeds.find(v => v > current + EPS) || speeds[speeds.length - 1];

        setSpeed(next);
    }

    // ============================================================
    // KEYBOARD SPEED STEPS (same block in Speed-Menu.js)
    // ============================================================
    // Jellyfin's own speed keys (10.10: ">" / "<", 12.1: Shift + the
    // Period / Comma key) step through Jellyfin's built-in rates only, and
    // from any rate missing there (custom 0.33x, 5x, ...) they jump to its
    // first entry, 0.5x. Jellyfin calls preventDefault() on every key it
    // handles, so right after it (window, bubble phase) the step is redone
    // through the custom list: the next rate above / below the one before
    // the key, staying put at the ends like Jellyfin. Which keys count is
    // left to the running Jellyfin version; no key is added. Installed
    // once, by whichever speed addon loads first.
    function installSpeedKeys(getList) {
        if (window.JellyfinVideoOSDSpeedKeys) return;
        window.JellyfinVideoOSDSpeedKeys = true;

        const EPS = 0.0001;
        let rateBefore = null;

        window.addEventListener('keydown', () => {
            const video = document.querySelector('video');
            rateBefore = video ? video.playbackRate : null;
        }, true);

        window.addEventListener('keydown', e => {
            const before = rateBefore;
            rateBefore = null;

            if (before === null || !e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;

            const up = e.key === '>' || (e.shiftKey && e.code === 'Period');
            const down = e.key === '<' || (e.shiftKey && e.code === 'Comma');
            if (up === down) return;
            if (!document.querySelector('#videoOsdPage:not(.hide)')) return;

            const list = getList();
            if (!list.length) return;

            // No nullish coalescing: these scripts also run on older TV browsers.
            const found = up
                ? list.find(v => v > before + EPS)
                : [...list].reverse().find(v => v < before - EPS);
            const next = found !== undefined ? found : before;

            const videos = [...document.querySelectorAll('video')];
            if (!videos.length || Math.abs(videos[0].playbackRate - next) < EPS) return;

            videos.forEach(video => {
                video.playbackRate = next;
            });
            try {
                // Jellyfin keeps the speed for the next item from here.
                sessionStorage.setItem('playbackRateSpeed', String(next));
            } catch (err) {
                /* storage unavailable: speed applies to this item only */
            }
        });
    }

    // Custom speeds count while these buttons are on, or whenever the
    // speed menu (which owns the shared list) is loaded.
    installSpeedKeys(() => (window.JellyfinCustomPlaybackSpeed || enabled) ? getSpeeds() : []);

    function createButton(icon, title, direction) {
        const button = document.createElement('button');

        button.type = 'button';
        button.className = BUTTON_CLASS + ' autoSize paper-icon-button-light';
        button.title = title;
        button.setAttribute('aria-label', title);

        const span = document.createElement('span');
        span.className = 'xlargePaperIconButton material-icons';
        span.setAttribute('aria-hidden', 'true');
        span.textContent = icon;

        button.appendChild(span);

        [
            'pointerdown',
            'pointerup',
            'mousedown',
            'mouseup',
            'touchstart',
            'touchend',
            'dblclick'
        ].forEach(type => {
            button.addEventListener(type, stop, true);
        });

        button.addEventListener('click', function (e) {
            stop(e);
            stepSpeed(direction);
        }, true);

        return button;
    }

    function createSpeedField() {
        const input = document.createElement('input');

        input.type = 'text';
        input.className = FIELD_CLASS;
        input.value = '1x';
        input.readOnly = true;
        // TV layout: the remote's D-pad only reaches focusable elements
        // (Jellyfin's focusManager skips tabindex -1), so the field takes
        // focus there and Enter resets the speed; arrow keys pass on to
        // the D-pad navigation. Elsewhere it stays out of the tab order.
        const tvLayout = document.documentElement.classList.contains('layout-tv');
        input.tabIndex = tvLayout ? 0 : -1;
        input.title = 'Reset speed';
        input.setAttribute('aria-label', 'Reset speed');

        [
            'pointerdown',
            'pointerup',
            'mousedown',
            'mouseup',
            'touchstart',
            'touchend',
            'dblclick'
        ].forEach(type => {
            input.addEventListener(type, stop, true);
        });

        input.addEventListener('keydown', function (e) {
            if (!tvLayout) {
                stop(e);
                return;
            }
            if (e.key === 'Enter' || e.keyCode === 13) {
                stop(e);
                resetSpeed();
                return;
            }
            // Jellyfin's D-pad navigation leaves left/right to a text
            // input (caret), so the field passes them to its neighbours
            // (the − and + buttons) itself.
            const neighbour = e.key === 'ArrowRight' ? input.nextElementSibling
                : e.key === 'ArrowLeft' ? input.previousElementSibling
                    : null;
            if (neighbour && typeof neighbour.focus === 'function') {
                stop(e);
                neighbour.focus();
            }
        }, true);

        input.addEventListener('click', function (e) {
            stop(e);
            resetSpeed();
        }, true);

        return input;
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;

        // Button size follows jellyfin-web's native OSD button
        // (.paper-icon-button-light, emby-button.scss): no fixed size,
        // the box is the icon (1.66956521739em, line-height 1) plus
        // 0.556em padding per side = 2.7816em, and the round hover disc
        // is that box.
        // The container is exactly as wide as its content, including
        // the buttons' native class margins (0.29em per side):
        // 2 x (0.29 + 2.7816 + 0.29) + 3.8em field = 10.5232em. With
        // "justify-content: center", extra width would become invisible
        // padding inside the container that applySpacing() can't
        // control; too little would push the outer buttons into their
        // neighbours ("overflow: visible").
        // No container margins here: a class rule can't be cleared by
        // applySpacing(), which together with the Core script owns all
        // outer spacing.
        // No own hover/active rules for the buttons: the
        // "paper-icon-button-light" class lets the active theme supply
        // the native disc (colour per theme, hover media guard, 0.2s
        // transition), and native buttons don't scale on press. Only
        // the "1x" field has its own rectangular hover/active below.
        // Keep comments out of the CSS text: a "//" line inside a CSS
        // rule silently drops the following declaration.
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${CONTAINER_CLASS} {
                position: relative;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 10.5232em;
                min-width: 10.5232em;
                max-width: 10.5232em;
                height: 0;
                min-height: 0;
                max-height: 0;
                margin-left: 0;
                margin-right: 0;
                padding: 0;
                overflow: visible;
                flex: 0 0 10.5232em;
                vertical-align: middle;
            }

            .${BUTTON_CLASS} {
                border: 0;
                background: transparent;
                color: inherit;
                cursor: pointer;
                padding: 0;
                width: 2.7816em;
                height: 2.7816em;
                min-height: 2.7816em;
                max-height: 2.7816em;
                line-height: 1;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 2.7816em;
            }

            .${BUTTON_CLASS} .material-icons,
            .${BUTTON_CLASS} .xlargePaperIconButton {
                line-height: 1;
            }

            .${FIELD_CLASS} {
                width: 3.8em;
                min-width: 3.8em;
                max-width: 3.8em;
                height: 2.7816em;
                min-height: 2.7816em;
                max-height: 2.7816em;
                padding: 0;
                border: 0;
                outline: 0;
                background: transparent;
                color: inherit;
                text-align: center;
                font: inherit;
                font-weight: 600;
                line-height: 1;
                cursor: pointer;
                user-select: none;
                flex: 0 0 3.8em;
            }

            .${FIELD_CLASS}:hover {
                background-color: rgba(0, 164, 220, 0.2);
                border-radius: .6em;
            }

            .${FIELD_CLASS}:active {
                transform: scale(.94);
            }

            .${FIELD_CLASS}:focus {
                outline: 0;
                box-shadow: none;
            }
        `;
        // The narrow-window "@media (max-width: 50em)" rule lives in its
        // own style tag (refreshResponsiveStyle() below), so
        // CONFIG.hideOnNarrowWindow can remove it without touching the
        // rest of this styling.

        document.head.appendChild(style);
    }

    // Separate, removable style tag driven by CONFIG.hideOnNarrowWindow
    // (same pattern as A-B-Loop).
    function refreshResponsiveStyle() {
        const existing = document.getElementById(RESPONSIVE_STYLE_ID);
        if (!CONFIG.hideOnNarrowWindow) {
            if (existing) existing.remove();
            return;
        }
        if (existing) return;
        const style = document.createElement('style');
        style.id = RESPONSIVE_STYLE_ID;
        style.textContent = `@media all and (max-width: 50em) { .videoOsdBottom .${CONTAINER_CLASS} { display: none !important; } }`;
        document.head.appendChild(style);
    }

    // Native OSD buttons are not flush: each carries "margin: 0 0.29em"
    // from "paper-icon-button-light", and ".videoOsdBottom .buttons" has
    // no "gap" of its own, so per-button margin is the only spacing.
    // The outer-facing margins of the first/last buttons are pinned to
    // that native 0.29em, so with no gap the group looks exactly like
    // native buttons.
    // The configured gap is not applied here. The container has a fixed
    // width (see injectStyle()), and a fixed-width flex item can't grow
    // from its children's margins, so the gap has to sit on the
    // container's own outer margins (inline style wins over the class
    // rule's "margin-left/right: 0"). Applied symmetrically, it would
    // double between two adjacent custom addons, and only the Core
    // script knows the final neighbours after sorting. So the Core's
    // applyCustomGapSpacing() owns the gap (neighbour-aware, re-derived
    // after every sort, 1x the configured value per gap) and sets these
    // container margins; this function leaves them cleared, which is
    // correct standalone and until the Core's next pass.
    function applySpacing(container) {
        const NATIVE_BUTTON_MARGIN_EM = 0.29;
        const buttons = container.querySelectorAll('.' + BUTTON_CLASS);
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (first) first.style.marginLeft = NATIVE_BUTTON_MARGIN_EM + 'em';
        if (last) last.style.marginRight = NATIVE_BUTTON_MARGIN_EM + 'em';
        if (container.style.marginLeft !== '') container.style.marginLeft = '';
        if (container.style.marginRight !== '') container.style.marginRight = '';
    }

    function bindRateChange(video) {
        if (video.dataset.jfbSpeedStepBound === '1') return;

        video.dataset.jfbSpeedStepBound = '1';
        video.addEventListener('ratechange', updateSpeedField);
    }

    function removeButtons() {
        document
            .querySelectorAll('.' + CONTAINER_CLASS)
            .forEach(el => el.remove());
    }

    function injectButtons() {
        if (!enabled) return;

        const video = getVideo();
        const transportBar = getTransportBar();

        if (!video || !transportBar) return;

        bindRateChange(video);

        // Insert inside transportBar (appendChild, next to the vanilla
        // buttons and A-B Loop's button), not as a sibling after it:
        // the Core script's sort (applyBottomLeftOrder()) only looks
        // inside transportBar, so a container outside it would never
        // be sorted.
        if (transportBar.querySelector('.' + CONTAINER_CLASS)) {
            updateSpeedField();
            return;
        }

        injectStyle();
        refreshResponsiveStyle();

        const container = document.createElement('div');
        container.className = CONTAINER_CLASS;

        container.appendChild(createButton(
            'keyboard_double_arrow_left',
            'Decrease speed',
            -1
        ));

        container.appendChild(createSpeedField());

        container.appendChild(createButton(
            'keyboard_double_arrow_right',
            'Increase speed',
            1
        ));

        transportBar.appendChild(container);
        applySpacing(container);

        updateSpeedField();

    }

    function startObserver() {
        if (observer) return;

        observer = new MutationObserver(() => {
            injectButtons();
            tryRegisterWithCustoms();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class']
        });
    }

    function stopObserver() {
        if (!observer) return;

        observer.disconnect();
        observer = null;
    }

    function enable() {
        enabled = true;
        startObserver();
        injectButtons();

    }

    function disable() {
        enabled = false;
        stopObserver();
        removeButtons();

    }

    function tryRegisterWithCustoms() {
        if (registeredWithCustoms) return false;

        const api = window[CUSTOMS_API_NAME];

        if (!api || typeof api.registerAddon !== 'function') {
            return false;
        }

        registeredWithCustoms = true;

        if (localStorage.getItem(CUSTOMS_STORAGE_KEY) === null) {
            localStorage.setItem(CUSTOMS_STORAGE_KEY, 'true');
        }

        api.registerAddon({
            id: ADDON_ID,
            name: ADDON_NAME,

            enable() {
                ignoreStoredCustomsState = false;
                enable();
            },

            disable() {
                ignoreStoredCustomsState = false;
                disable();
            }
        });

        if (!ignoreStoredCustomsState) {
            if (isEnabledByCustomsState()) {
                enable();
            } else {
                disable();
            }
        } else {
            enable();
        }


        return true;
    }

    function startCustomsRegistrationWatcher() {
        tryRegisterWithCustoms();

        if (registeredWithCustoms) return;

        let tries = 0;

        customsRegisterTimer = setInterval(() => {
            tries += 1;
            tryRegisterWithCustoms();

            if (registeredWithCustoms || tries >= CUSTOMS_WAIT_TRIES) {
                clearInterval(customsRegisterTimer);
                customsRegisterTimer = null;
            }
        }, CUSTOMS_WAIT_MS);
    }

    function start() {
        if (isCustomsAvailable()) {
            ignoreStoredCustomsState = false;
            tryRegisterWithCustoms();
        } else {
            ignoreStoredCustomsState = true;
            enable();
        }

        startCustomsRegistrationWatcher();

        console.log('[VideoOSD Speed Buttons] Script loaded.');
    }

    if (document.documentElement) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start, {
            once: true
        });
    }

    // ---- PLUGIN ADAPTER: apply fetched config once it arrives ----
    fetchPluginConfig().then(function (pluginConfig) {
        applyPluginConfig(pluginConfig);
        refreshResponsiveStyle();
        const container = document.querySelector('.' + CONTAINER_CLASS);
        if (container) applySpacing(container);
    }).catch(function (err) {
        console.error('[VideoOSD Speed Buttons] config apply failed:', err);
    });
    // ---- END PLUGIN ADAPTER ----
})();
