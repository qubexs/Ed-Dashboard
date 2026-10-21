(function () {
  "use strict";

  var clockEl = document.getElementById("clock");
  var lastUpdatedEl = document.getElementById("lastUpdated");
  var liveDot = document.getElementById("liveDot");
  var liveLabel = document.getElementById("liveLabel");
  var waitingEl = document.getElementById("waitingTime");
  var totalEl = document.getElementById("totalSinceMidnight");
  var wardEl = document.getElementById("wardWaiting");
  var wardCountEl = document.getElementById("wardWaitingCount");

  var timezone = document.body.getAttribute("data-timezone") || "Asia/Kuala_Lumpur";
  var refreshMs = Math.max(5, Number(document.body.getAttribute("data-refresh")) || 10) * 1000;
  var timer = null;
  var lastGoodUpdate = null;

  function formatClock(date) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function formatDateTime(date) {
    var time = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
    var day = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(date);
    return time + "  " + day;
  }

  function tickClock() {
    if (clockEl) clockEl.textContent = formatClock(new Date());
  }

  function setNumber(el, value) {
    if (!el) return;
    var next = new Intl.NumberFormat("en-US").format(Number(value) || 0);
    if (el.textContent === next) return;
    el.textContent = next;
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }

  function setLive(online) {
    if (liveDot) liveDot.classList.toggle("offline", !online);
    if (liveLabel) liveLabel.textContent = online ? "LIVE" : "RECONNECTING";
  }

  function updateZones(zones) {
    if (!Array.isArray(zones)) return;
    zones.forEach(function (zone) {
      var card = document.querySelector('[data-zone-code="' + zone.code + '"]');
      if (!card) return;
      var count = card.querySelector("[data-zone-count]");
      if (count) setNumber(count, zone.count);
    });
  }

  function apply(data) {
    setNumber(waitingEl, data.waitingTimeMinutes);
    setNumber(totalEl, data.totalSinceMidnight);
    setNumber(wardEl, data.wardWaitingMinutes);
    setNumber(wardCountEl, data.wardWaitingPatients);
    updateZones(data.zones);

    if (data.meta && data.meta.timezone) timezone = data.meta.timezone;
    lastGoodUpdate = data.meta && data.meta.generatedAt
      ? new Date(data.meta.generatedAt)
      : new Date();
    if (lastUpdatedEl) lastUpdatedEl.textContent = formatDateTime(lastGoodUpdate);
    tickClock();
    setLive(true);

    var nextMs = Math.max(5, Number(data.meta && data.meta.refreshSeconds) || 10) * 1000;
    if (nextMs !== refreshMs) {
      refreshMs = nextMs;
      schedule();
    }
  }

  function load() {
    var controller = new AbortController();
    var timeout = setTimeout(function () {
      controller.abort();
    }, Math.max(4000, refreshMs - 1000));

    fetch("/api/dashboard", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(apply)
      .catch(function () {
        setLive(false);
      })
      .finally(function () {
        clearTimeout(timeout);
      });
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(load, refreshMs);
  }

  tickClock();
  setInterval(tickClock, 1000);
  load();
  schedule();
})();
