(function () {
    'use strict';

    // ---- PLUGIN ADAPTER: config source, retrofit for VideoOSD Tweaks and Candy ----
    const PLUGIN_GUID = '468b1980-7a6c-4e45-a129-24825085ece4';

    const CONFIG = {
        // ============================================================
        // == SHARED VALUE (both standalone and plugin usage) ==
        // Standalone: this mod never had a "hide on narrow window"
        // setting before this retrofit at all, only a permanently
        // fixed CSS media rule -- true here reproduces that exact
        // original always-on behavior.
        // Plugin: overwritten by applyPluginConfig() with the
        // admin's "Hide on Narrow Window" setting once fetched.
        // ============================================================
        hideOnNarrowWindow: true,

        // ============================================================
        // == SHARED VALUE, correct for both cases here ==
        // This mod never had ANY configurable spacing before this
        // retrofit, only a permanently fixed .25em CSS margin (see
        // applySpacing() below). 0 is correct as both the standalone
        // default (produces an empty inline style, so the plain CSS
        // .25em rule applies untouched, exactly like before) and the
        // plugin's own "opt-in, not opt-out" baseline. Unlike
        // A-B-Loop, no dual-mode branch is needed here, there was no
        // pre-existing visible behavior at a nonzero default to
        // preserve.
        // ============================================================
        centeredGapEm: 0
    };

    async function fetchPluginConfig() {
        const maxAttempts = 120;
        const delayMs = 250;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (window.ApiClient && typeof ApiClient.getPluginConfiguration === 'function') {
                try {
                    const config = await ApiClient.getPluginConfiguration(PLUGIN_GUID);
                    if (config) return config;
                } catch (err) {
                    // fall through, try again after the delay below
                }
            }
            await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
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
        return document.querySelector('.buttons.focuscontainer-x > div[dir="ltr"]');
    }

    function getSpeedField() {
        return document.querySelector('.' + FIELD_CLASS);
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

        console.log('[Jellyfin Speed Buttons] Speed set:', rate);
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
        input.tabIndex = -1;
        input.title = 'Reset speed to 1x';
        input.setAttribute('aria-label', 'Reset speed to 1x');

        [
            'pointerdown',
            'pointerup',
            'mousedown',
            'mouseup',
            'touchstart',
            'touchend',
            'dblclick',
            'keydown'
        ].forEach(type => {
            input.addEventListener(type, stop, true);
        });

        input.addEventListener('click', function (e) {
            stop(e);
            resetSpeed();
        }, true);

        return input;
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;

        // FIX for a real, confirmed bug found live, verified with an
        // actual measured browser render: this container was hardcoded
        // to 13.4em wide, but its actual content (one 3.2em button + one
        // 3.8em field + one 3.2em button = 10.2em) only fills 10.2em of
        // it. With "justify-content: center", the leftover 3.2em split
        // evenly into an invisible 1.6em (25.6px) of phantom padding on
        // EACH side, inside the container, completely hidden from and
        // uncontrolled by applySpacing()'s own margin logic on the
        // actual first/last buttons. Fixed to the real, correct total
        // (10.2em), which leaves zero leftover space to hide in.
        //
        // FIX for a second, real, confirmed bug found live: this used to
        // also hardcode "margin-left/right: .25em" here, completely
        // independent of applySpacing()'s own margin logic on the
        // individual first/last buttons. applySpacing() clearing the
        // CONTAINER's own inline margin style only removes an inline
        // override, it can't touch this CSS class rule, so this fixed
        // .25em was silently adding on top of whatever applySpacing()
        // computed, on both sides, all the time, regardless of the
        // configured gap. Removed entirely: applySpacing() is now the
        // single, sole source of truth for this container's spacing.
        //
        // FIX for a third, real, more fundamental bug found live during
        // a later, more thorough review: the two explanations above used
        // to live as "//" comments INSIDE the CSS text below (i.e.
        // actually part of style.textContent, not real JavaScript
        // comments), which is invalid CSS syntax, confirmed with an
        // actual browser render: a "//" line inside a CSS rule silently
        // drops at least the following declaration, meaning the very
        // "width: 10.2em"/"margin-left: 0" fixes those comments were
        // documenting had a real chance of never actually taking effect
        // in a real browser, entirely undetected by earlier tests, since
        // those only checked DOM ordering, not the actual rendered CSS
        // width. Moved out here as genuine JS comments, the CSS text
        // below is now valid.
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${CONTAINER_CLASS} {
                position: relative;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 10.2em;
                min-width: 10.2em;
                max-width: 10.2em;
                height: 0;
                min-height: 0;
                max-height: 0;
                margin-left: 0;
                margin-right: 0;
                padding: 0;
                overflow: visible;
                flex: 0 0 10.2em;
                vertical-align: middle;
            }

            .${BUTTON_CLASS} {
                border: 0;
                background: transparent;
                color: inherit;
                cursor: pointer;
                padding: 0;
                width: 3.2em;
                height: 3.2em;
                min-height: 3.2em;
                max-height: 3.2em;
                line-height: 1;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 3.2em;
            }

            .${BUTTON_CLASS} .material-icons,
            .${BUTTON_CLASS} .xlargePaperIconButton {
                line-height: 1;
            }

            .${BUTTON_CLASS}:hover {
                background-color: rgba(0, 164, 220, 0.2);
                border-radius: 50%;
            }

            .${BUTTON_CLASS}:active {
                transform: scale(.94);
            }

            .${FIELD_CLASS} {
                width: 3.8em;
                min-width: 3.8em;
                max-width: 3.8em;
                height: 3.2em;
                min-height: 3.2em;
                max-height: 3.2em;
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
        // Note: the "@media (max-width: 50em) { display: none }" rule that
        // used to live inline in this same stylesheet has been pulled out
        // into its own separate, independently toggleable style tag, see
        // refreshResponsiveStyle() below -- CONFIG.hideOnNarrowWindow can
        // now be turned off via the plugin, which needs to be able to
        // remove that rule without touching the rest of this styling.

        document.head.appendChild(style);
    }

    // New: previously this behavior was permanently baked into injectStyle()
    // above with no way to turn it off. Same pattern used across the other
    // retrofitted mods (see A-B-Loop) -- a separate, removable style tag
    // driven by CONFIG.hideOnNarrowWindow.
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

    // FIX for 2 real, confirmed issues found live, in sequence:
    // 1) This originally only set margin on the CONTAINER, while the
    //    individual buttons inside carry their own native margin from
    //    "paper-icon-button-light", unaffected by the container's own
    //    margin. Fixed by overriding the actual first/last button's own
    //    outer-facing margin directly instead.
    // 2) That first fix initially zeroed the margin at "gap 0", but per
    //    direct discussion with the user and confirmed against the real
    //    source, "gap 0" should mean "looks exactly like a native
    //    button", not "touching, 0px": native buttons are NOT flush
    //    against each other (each carries "margin: 0 0.29em" from
    //    "paper-icon-button-light", and ".videoOsdBottom .buttons" has
    //    no "gap" property of its own, so per-button margin is the ONLY
    //    spacing mechanism). Native 0.29em is now the baseline, with the
    //    user's own configured gap value added on top.
    function applySpacing(container) {
        const gapEm = CONFIG.centeredGapEm || 0;
        const NATIVE_BUTTON_MARGIN_EM = 0.29;
        const buttons = container.querySelectorAll('.' + BUTTON_CLASS);
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        container.style.marginLeft = '';
        container.style.marginRight = '';
        if (first) first.style.marginLeft = (NATIVE_BUTTON_MARGIN_EM + gapEm) + 'em';
        if (last) last.style.marginRight = (NATIVE_BUTTON_MARGIN_EM + gapEm) + 'em';
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

        // FIX for a real, serious bug found live, only caught via a
        // fully faithful test (the real script, the real Jellyfin HTML,
        // a real browser -- a simplified stand-in test never would have
        // caught this): this used to check transportBar.parentElement
        // and insert via "insertAdjacentElement('afterend', container)"
        // relative to transportBar itself, which inserts as a SIBLING of
        // transportBar (i.e. one level OUTSIDE it, alongside
        // ".buttons.focuscontainer-x" itself), not inside it. ABLoop's
        // own script, by contrast, inserts relative to the last vanilla
        // button (which genuinely IS inside transportBar), ending up
        // one level deeper than Speed/FrameByFrame did. Confirmed live:
        // Core's own sort logic (applyBottomLeftOrder() in the Core
        // script) only ever looks inside transportBar for these 3
        // items, so it could never even find this container at all,
        // silently failing to include it in any configured sort order.
        // Fixed to insert inside transportBar (appendChild, alongside
        // the vanilla buttons and ABLoop's own button), consistent with
        // where Core's sort logic actually looks, and with how ABLoop
        // itself already correctly does this.
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
            'One speed step slower',
            -1
        ));

        container.appendChild(createSpeedField());

        container.appendChild(createButton(
            'keyboard_double_arrow_right',
            'One speed step faster',
            1
        ));

        transportBar.appendChild(container);
        applySpacing(container);

        updateSpeedField();

        console.log('[Jellyfin Speed Buttons] Buttons inserted.');
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

        console.log('[Jellyfin Speed Buttons] Enabled.');
    }

    function disable() {
        enabled = false;
        stopObserver();
        removeButtons();

        console.log('[Jellyfin Speed Buttons] Disabled.');
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

        console.log('[Jellyfin Speed Buttons] Registered with Customs.');

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

        console.log('[Jellyfin Speed Buttons] Script loaded.');
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
    });
    // ---- END PLUGIN ADAPTER ----
})();
