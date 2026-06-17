/* uhr.js — TimeNL Digitale Klok
 * Version: 20260617-03 (https://time.nl)
 * Loosely based on the one by PTB: https://uhr.ptb.de
 * Partly vibe coded with several models, including ChatGPT, Gemini and Claude
 * SIDN Labs — M. Davids
 *
 * Simplified version - does not do leapseconds and has no speech.
 *
 */
(function () {
  'use strict';

  // -- DOM refs ----------------------------------------------------------------

  const el = (id) => document.getElementById(id);

  const dom = {
    time:            el('timenlTime'),
    date:            el('timenlDate'),
    timezone:        el('timenlLocalTimezone'),
    notice:          el('timenlNotice'),
    faceBackground:  el('timenlDisplayBackground'),
    deviation:       el('timenlDeviation'),
    deviationIcon:   el('timenlDeviationIcon'),
    deviationNeedle: el('timenlDeviationNeedle'),
    offset:          el('timenlOffset'),
    accuracy:        el('timenlAccuracy'),
  };

  // -- Focus-outline fix -------------------------------------------------------
  // Bootstrap's :focus-visible stijlen overschrijven de CSS-regels in uhr.css
  // wanneer de klok in een pagina-context zit. We lossen dit op met een inline
  // style op het element zelf — dat heeft hogere specificiteit dan Bootstrap.

  if (dom.timezone) {
    dom.timezone.style.outline = 'none';
    dom.timezone.addEventListener('focus', () => {
      dom.timezone.style.outline = 'none';
    });
  }

  // -- Helpers -----------------------------------------------------------------

  const show = (el) => el && el.removeAttribute('visibility');
  const hide = (el) => el && el.setAttribute('visibility', 'hidden');

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // -- Timezone Cycle State Machine --------------------------------------------

  const tzModes = ['nl', 'utc', 'local'];
  let currentTzIdx = 2;

  function cycleTimezone() {
    currentTzIdx = (currentTzIdx + 1) % tzModes.length;
    if (typeof timeDelta !== 'undefined') {
      renderClockTick();
    }
  }

  if (dom.timezone) {
    dom.timezone.addEventListener('click', cycleTimezone);
    dom.timezone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        cycleTimezone();
      }
    });
  }

  // -- Deviation Icon Logic ---------------------------------------------------

  let deviationVisible = false;

  function toggleDeviation() {
    deviationVisible = !deviationVisible;
    if (deviationVisible) {
      show(dom.deviation);
      if (dom.deviationIcon) dom.deviationIcon.classList.add('active');
    } else {
      hide(dom.deviation);
      if (dom.deviationIcon) dom.deviationIcon.classList.remove('active');
    }
  }

  if (dom.deviationIcon) {
    dom.deviationIcon.addEventListener('click', toggleDeviation);
    dom.deviationIcon.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDeviation(); }
    });
  }

  // -- View helpers ------------------------------------------------------------

  function setTime(h, m, s) {
    if (dom.time) dom.time.textContent = `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  function setDate(d, m, y) {
    if (dom.date) dom.date.textContent = `${pad2(d)}.${pad2(m)}.${y}`;
  }

  function setTimezone(label) {
    if (dom.timezone) dom.timezone.textContent = label;
  }

  function setAccuracy(ms) {
    if (dom.accuracy) {
      dom.accuracy.textContent = `\xB1 ${ms} ms`;
    }
  }

  function setOffset(text) {
    if (dom.offset) dom.offset.textContent = text;
  }

  function setConnected(isConnected) {
    if (isConnected) {
      if (dom.faceBackground) dom.faceBackground.setAttribute('fill', dom.faceBackground.dataset.fillConnected);
      hide(dom.notice);
      show(dom.time);
      show(dom.deviationIcon);
      if (deviationVisible) {
        show(dom.deviation);
        if (dom.deviationIcon) dom.deviationIcon.classList.add('active');
      } else {
        hide(dom.deviation);
        if (dom.deviationIcon) dom.deviationIcon.classList.remove('active');
      }
    } else {
      if (dom.faceBackground) dom.faceBackground.setAttribute('fill', dom.faceBackground.dataset.fillDisconnected);
      if (dom.notice) {
        dom.notice.textContent = dom.notice.dataset.notConnected;
        show(dom.notice);
      }
      hide(dom.time);
      hide(dom.deviationIcon);
      hide(dom.deviation);
    }
  }

  function resetClock() {
    setConnected(false);
    setTime('--', '--', '--');
    setTimezone('--');
    setDate('--', '--', '----');
  }

  // -- System-time deviation display ------------------------------------------

  function timeDiff(networkTimeUTC) {
    let delta = Date.now() - networkTimeUTC.getTime();
    const behind = delta < 0;
    if (behind) delta = -delta;

    const units = [
      ['d',   24 * 60 * 60 * 1000],
      ['h',   60 * 60 * 1000],
      ['min', 60 * 1000],
      ['s',   1000],
      ['ms',  1],
    ];

    const parts = [];
    for (const [label, ms] of units) {
      const count = Math.floor(delta / ms);
      delta %= ms;
      if (count !== 0) parts.push(`${count} ${label}`);
    }

    parts.push(parts.length === 0 ? 'exact match' : (behind ? 'behind' : 'ahead'));
    setOffset(parts.join(' '));
  }

  // -- WebSocket / clock loop -------------------------------------------------
  //
  // Reconnect-strategie:
  //   - Eén centrale reconnect-timer (rcTimeout). Als er al een timer loopt,
  //     wordt er nooit een tweede gestart.
  //   - cbTimeout (clockBeat) wordt altijd gecleard bij onclose/onerror,
  //     zodat de klok stopt met tikken als er geen verbinding is.
  //   - ppTimeout (polling) wordt gecleard bij verbreken.
  //   - Bij focus op het venster wordt direct een reconnect geprobeerd,
  //     maar alleen als de socket echt gesloten is.

  const REDO_MS  = 60_000;
  const SAMPLE_N = 5;

  let wsock;
  let ppTimeout, cbTimeout, rcTimeout;
  let ppActiv   = false;
  let samples   = [];
  let timeDelta;
  let prevClockTime = null;

  // Centrale cleanup: zet alles stil en registreer de verbinding als verbroken.
  function teardown() {
    clearTimeout(ppTimeout);
    clearTimeout(cbTimeout);
    cbTimeout = undefined;
    ppActiv   = false;
    // prevClockTime hier resetten (niet pas bij onopen): teardown draait
    // onvoorwaardelijk bij elke onclose, terwijl onopen's reset achter de
    // ppActiv-guard zat. Zonder deze reset bleef een oude tikwaarde staan
    // die na reconnect tegen een verse tik werd afgezet — dat leverde een
    // schijnbare hapering van vele seconden op en een oneindige
    // reconnect-loop die nooit tot een stabiele klok kwam.
    prevClockTime = null;
    resetClock();
  }

  // Plan een reconnect, maar alleen als er nog geen timer loopt.
  function scheduleReconnect() {
    if (rcTimeout) return;            // al ingepland, niet dubbel doen
    rcTimeout = setTimeout(() => {
      rcTimeout = undefined;
      if (!wsock || wsock.readyState === WebSocket.CLOSED) {
        console.log('Reconnect poging, wachttijd was:', reconnect.wait, 'ms');
        connectWebSocket();
        if (reconnect.wait < 120_000) reconnect.wait = Math.min(reconnect.wait * 1.3, 120_000);
      }
    }, reconnect.wait);
  }

  function connectWebSocket() {
    // Voorkom dubbele sockets
    if (wsock && wsock.readyState !== WebSocket.CLOSED) return;

    // Productie
    wsock = new WebSocket("wss://klok.sidnlabs.nl:8123/time");
    // Test
    //wsock = new WebSocket("ws://localhost:8123/time");

    wsock.onmessage = function (evnt) {
      const sdata = JSON.parse(evnt.data);
      const rtt   = performance.now() - sdata.c;
      const delta = performance.now() - sdata.s - rtt / 2;

      samples.push([delta, rtt, sdata.e]);
      if (samples.length > SAMPLE_N) samples.shift();

      const sorted = [...samples].sort((a, b) => a[1] - b[1]);
      timeDelta = sorted[0][0];
      setAccuracy(Math.round(sorted[0][1] / 2 + sorted[0][2]));

      if (typeof cbTimeout === 'undefined') {
        const networkNow = new Date(performance.now() - timeDelta);
        cbTimeout = setTimeout(clockBeat, 1000 - networkNow.getMilliseconds());
      }

      if (samples.length < SAMPLE_N) {
        wsock.send(JSON.stringify({ c: performance.now() }));
      } else {
        ppActiv = false;
        ppTimeout = setTimeout(() => {
          if (wsock && wsock.readyState === WebSocket.OPEN) {
            samples = [];
            ppActiv = true;
            console.log('Tijdmeting herstart (periodiek)');
            wsock.send(JSON.stringify({ c: performance.now() }));
          }
        }, REDO_MS);
      }
    };

    wsock.onopen = function () {
      if (!ppActiv) {
        clearTimeout(ppTimeout);
        clearTimeout(cbTimeout);
        cbTimeout = undefined;
        clearTimeout(rcTimeout);
        rcTimeout = undefined;
        reconnect.wait = Math.random() * 1000 + 1000;  // reset backoff
        samples  = [];
        ppActiv  = true;
        console.log('WebSocket verbonden, tijdmeting gestart');
        wsock.send(JSON.stringify({ c: performance.now() }));
        setConnected(true);
      }
    };

    wsock.onclose = function () {
      console.log('WebSocket verbroken (onclose)');
      teardown();
      scheduleReconnect();
    };

    wsock.onerror = function (e) {
      console.warn('WebSocket fout (onerror):', e);
      // onerror wordt altijd gevolgd door onclose; teardown en scheduleReconnect
      // worden dus via onclose afgehandeld. Hier hoeven we niets extra's te doen.
    };
  }

  reconnect.wait = Math.random() * 1000 + 1000;

  function reconnect() {
    // Directe reconnect-poging (bijv. bij window focus of tab-wissel)
    if (!wsock || wsock.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    }
  }

  connectWebSocket();

  // -- Herstel-detectie bij terugkeer (focus én tab-visibility) ---------------
  //
  // 'focus' op window vuurt alleen bij wisselen tussen programma's, niet bij
  // het wisselen tussen tabbladen binnen dezelfde browser. 'visibilitychange'
  // dekt wél het tabblad-scenario. Beide events kunnen echter vlak na elkaar
  // vuren voor dezelfde "terugkeer"-gebeurtenis, dus er is een debounce-guard
  // nodig om dubbele, overlappende uitvoering te voorkomen.
  //
  // Daarnaast wordt alleen ingegrepen als de socket daadwerkelijk OPEN is.
  // Een socket in CONNECTING of CLOSING staat al midden in een overgang en
  // moet niet voortijdig gesloten worden — dat gaf eerder de fout "WebSocket
  // is closed before the connection is established".

  const STALE_THRESHOLD_MS = 5000;
  let checkingReturn = false;

  function checkAndRecoverOnReturn() {
    if (checkingReturn) return;   // voorkom overlappende uitvoering (focus + visibilitychange)
    checkingReturn = true;

    try {
      console.log('Terugkeer naar pagina/tab: verbinding wordt gecontroleerd');

      if (!wsock || wsock.readyState === WebSocket.CLOSED) {
        reconnect();
        return;
      }

      // Alleen direct ingrijpen bij een socket die daadwerkelijk OPEN is.
      // CLOSING laten we ongestoord aflopen (al onderweg naar dicht).
      // CONNECTING krijgt een eigen, geduldige tijdslimiet: als de
      // handshake na terugkeer te lang blijft hangen (bijv. een verzoek
      // dat is "vergeten" door een uitgehongerde achtergrond-tab, zonder
      // dat er ooit een error/close-event volgt), wordt hij alsnog
      // afgebroken zodat een verse reconnect kan starten.
      if (wsock.readyState === WebSocket.CONNECTING) {
        const staleSocket = wsock;
        setTimeout(() => {
          if (staleSocket === wsock && wsock.readyState === WebSocket.CONNECTING) {
            console.log('Socket hangt nog in CONNECTING na terugkeer — wordt afgebroken voor reconnect');
            wsock.close();   // triggert onclose -> teardown + scheduleReconnect
          }
        }, STALE_THRESHOLD_MS);
        return;
      }
      if (wsock.readyState !== WebSocket.OPEN) {
        return;   // CLOSING: niets te doen, laat 'm vanzelf sluiten
      }

      // Socket is open: check of de klok daadwerkelijk nog tikt.
      if (prevClockTime !== null) {
        const sinceLastTick = Date.now() - prevClockTime.getTime();
        if (sinceLastTick > STALE_THRESHOLD_MS) {
          console.log('Socket leek open, maar klok stond stil (' + sinceLastTick + 'ms) — socket wordt geforceerd herstart');
          clearTimeout(cbTimeout);
          cbTimeout = undefined;
          prevClockTime = null;
          wsock.close();   // triggert onclose -> teardown + scheduleReconnect
        }
      }
    } finally {
      // Korte afkoelperiode: voorkomt dat een vlak na elkaar vurende tweede
      // event (focus + visibilitychange) dezelfde controle dubbel uitvoert,
      // ook al is de eerste aanroep zelf al synchroon afgerond.
      setTimeout(() => { checkingReturn = false; }, 250);
    }
  }

  window.addEventListener('focus', checkAndRecoverOnReturn);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkAndRecoverOnReturn();
    }
  });

  // -- Clock tick engine -------------------------------------------------------

  function clockBeat() {
    const networkTimeUTC = new Date(performance.now() - timeDelta);
    cbTimeout = setTimeout(clockBeat, 1000 - networkTimeUTC.getMilliseconds());

    if (prevClockTime !== null && (networkTimeUTC - prevClockTime) > 3200) {
      if (dom.notice && (!dom.notice.hasAttribute('visibility'))) {
        clearTimeout(ppTimeout);
        samples = [];
        if (wsock && wsock.readyState === WebSocket.OPEN) {
          console.log('Klok loopt niet steady, tijdmeting opnieuw gestart');
          wsock.send(JSON.stringify({ c: performance.now() }));
        }
      } else {
        // De klok hapert al langer dan 3,2s EN de UI toonde "Connection
        // lost" al. Voorheen werd hier alleen de UI gereset, zonder de
        // WebSocket aan te raken — als die socket nog "open" stond (een
        // zombie-verbinding, bijv. na lange tab-inactiviteit), bleef hij
        // op de achtergrond doormeten terwijl de UI nooit meer herstelde,
        // want er kwam geen onclose-event om de reconnect te triggeren.
        // Daarom hier de socket nu actief sluiten, zodat onclose vuurt en
        // de normale teardown + scheduleReconnect-cyclus start.
        console.log('Klok hapert nog na disconnect-status — socket wordt geforceerd gesloten voor reconnect');
        clearTimeout(cbTimeout);
        cbTimeout = undefined;
        if (wsock && wsock.readyState !== WebSocket.CLOSED) {
          wsock.close();
        } else {
          // Geen socket (meer) om te sluiten: zorg dat reconnect alsnog loopt.
          teardown();
          scheduleReconnect();
        }
        return;
      }
    } else {
      renderClockTick(networkTimeUTC);
    }
    prevClockTime = new Date(networkTimeUTC);
  }

  function renderClockTick(forcedTime) {
    const networkTimeUTC = forcedTime || new Date(performance.now() - timeDelta);
    timeDiff(networkTimeUTC);

    const mode = tzModes[currentTzIdx];
    let targetZone = 'Europe/Amsterdam';
    let tzLabel    = 'SIDN Labs HQ NL';

    if (mode === 'utc') {
      targetZone = 'UTC';
      tzLabel    = 'UTC (Coordinated Universal Time)';
    } else if (mode === 'local') {
      try {
        targetZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        tzLabel    = targetZone;
      } catch {
        targetZone = 'UTC';
        tzLabel    = 'Local timezone';
      }
    }

    const parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: targetZone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false,
    }).formatToParts(networkTimeUTC).forEach((p) => { parts[p.type] = p.value; });

    const h  = parseInt(parts.hour,   10);
    const m  = parseInt(parts.minute, 10);
    const s  = parseInt(parts.second, 10);
    const d  = parseInt(parts.day,    10);
    const mo = parseInt(parts.month,  10);
    const y  = parseInt(parts.year,   10);

    setTime(h, m, s);
    setTimezone(tzLabel);
    setDate(d, mo, y);
  }

})();
