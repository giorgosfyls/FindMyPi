(function () {
  "use strict";

  var DATA_DIR = "data/";
  var PAGE_SIZE = 1000;   // digits shown at once
  var MAX_CACHED = 6;     // data files kept in memory at once

  var el = {
    available: document.getElementById("available"),
    form: document.getElementById("search-form"),
    query: document.getElementById("query"),
    result: document.getElementById("result"),
    position: document.getElementById("position"),
    digits: document.getElementById("digits"),
    prev: document.getElementById("prev"),
    next: document.getElementById("next"),
    gotoForm: document.getElementById("goto-form"),
    gotoInput: document.getElementById("goto")
  };

  var files = [];          // [{file, start, length}] from manifest.json
  var total = 0;           // total decimals available
  var cache = new Map();   // file index -> digit string (insertion order = LRU order)
  var viewStart = 0;       // first digit shown (zero-based)
  var highlight = null;    // {start, length} of the current match
  var searchToken = 0;     // incremented to cancel an in-flight search
  var renderToken = 0;

  function fmt(n) { return n.toLocaleString("en-US"); }

  function fail(msg) {
    el.result.textContent = msg;
  }

  function loadingHint() {
    if (location.protocol === "file:") {
      return " Browsers block loading local JSON files from file:// pages. Host this folder on a static website service (e.g. GitHub Pages) or any static file server.";
    }
    return "";
  }

  // ---- data loading -------------------------------------------------------

  function loadChunk(i) {
    if (cache.has(i)) {
      var hit = cache.get(i);
      cache.delete(i);
      cache.set(i, hit);          // mark as most recently used
      return Promise.resolve(hit);
    }
    var info = files[i];
    return fetch(DATA_DIR + info.file).then(function (res) {
      if (!res.ok) throw new Error(info.file + ": HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      if (!data || typeof data.digits !== "string" || !/^[0-9]+$/.test(data.digits)) {
        throw new Error(info.file + ": 'digits' must be a string of 0-9");
      }
      if (data.start !== info.start) {
        throw new Error(info.file + ": 'start' is " + data.start + " but manifest says " + info.start);
      }
      if (data.digits.length !== info.length) {
        throw new Error(info.file + ": has " + data.digits.length + " digits but manifest says " + info.length);
      }
      cache.set(i, data.digits);
      while (cache.size > MAX_CACHED) {
        cache.delete(cache.keys().next().value);
      }
      return data.digits;
    });
  }

  function chunkIndexFor(pos) {
    var lo = 0, hi = files.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (files[mid].start <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // Returns the digits in [start, start+len), possibly spanning several files.
  function getDigits(start, len) {
    var end = Math.min(start + len, total);
    var parts = [];
    function step(pos) {
      if (pos >= end) return Promise.resolve(parts.join(""));
      var i = chunkIndexFor(pos);
      return loadChunk(i).then(function (digits) {
        var from = pos - files[i].start;
        var to = Math.min(digits.length, end - files[i].start);
        parts.push(digits.slice(from, to));
        return step(files[i].start + to);
      });
    }
    return step(start);
  }

  // ---- display ------------------------------------------------------------

  function render() {
    var token = ++renderToken;
    var start = viewStart;
    return getDigits(start, PAGE_SIZE).then(function (text) {
      if (token !== renderToken) return;
      var end = start + text.length;           // exclusive
      el.digits.textContent = "";
      if (start === 0) el.digits.appendChild(document.createTextNode("3."));

      var hs = highlight ? Math.max(highlight.start, start) : -1;
      var he = highlight ? Math.min(highlight.start + highlight.length, end) : -1;
      if (highlight && hs < he) {
        el.digits.appendChild(document.createTextNode(text.slice(0, hs - start)));
        var mark = document.createElement("mark");
        mark.textContent = text.slice(hs - start, he - start);
        el.digits.appendChild(mark);
        el.digits.appendChild(document.createTextNode(text.slice(he - start)));
      } else {
        el.digits.appendChild(document.createTextNode(text));
      }

      el.position.textContent = "Showing digits " + fmt(start) + "–" + fmt(end - 1) +
        " of " + fmt(total) + " (zero-based positions after the decimal point)";
      el.prev.disabled = start === 0;
      el.next.disabled = end >= total;
    }).catch(function (err) {
      fail("Could not load digits: " + err.message + "." + loadingHint());
    });
  }

  function showAt(pos) {
    pos = Math.max(0, Math.min(pos, total - 1));
    viewStart = Math.floor(pos / PAGE_SIZE) * PAGE_SIZE;
    return render();
  }

  // ---- search -------------------------------------------------------------

  function tick() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  // Scans every data file in order. The last (q.length - 1) digits of what has
  // been scanned are carried into the next file so matches that cross a file
  // boundary are found. Returns the first (lowest) position, or -1.
  function findFirst(q, token, onProgress) {
    var tail = "";
    function scan(i) {
      if (token !== searchToken) return Promise.resolve(-2);   // cancelled
      if (i >= files.length) return Promise.resolve(-1);
      onProgress(i + 1);
      return loadChunk(i).then(function (digits) {
        var text = tail + digits;
        var idx = text.indexOf(q);
        if (idx >= 0) return files[i].start - tail.length + idx;
        tail = q.length > 1 ? text.slice(Math.max(0, text.length - (q.length - 1))) : "";
        return tick().then(function () { return scan(i + 1); });
      });
    }
    return scan(0);
  }

  function runSearch(q) {
    var token = ++searchToken;
    el.result.textContent = "Searching…";
    findFirst(q, token, function (n) {
      el.result.textContent = "Searching… file " + n + " of " + files.length;
    }).then(function (pos) {
      if (pos === -2 || token !== searchToken) return;
      el.result.textContent = "";
      if (pos < 0) {
        highlight = null;
        el.result.textContent = "Not found in the " + fmt(total) + " digits available (positions 0–" +
          fmt(total - 1) + "). This says nothing about digits beyond the loaded data.";
        return;
      }
      highlight = { start: pos, length: q.length };
      var span = document.createElement("span");
      span.textContent = "First occurrence starts at position " + fmt(pos) +
        " (zero-based; digit number " + fmt(pos + 1) + " after the decimal point).";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Show match";
      btn.addEventListener("click", function () { showAt(pos); });
      el.result.appendChild(span);
      el.result.appendChild(btn);
      showAt(pos);
    }).catch(function (err) {
      if (token === searchToken) fail("Search failed: " + err.message + "." + loadingHint());
    });
  }

  // ---- events -------------------------------------------------------------

  el.form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = el.query.value.replace(/\s+/g, "");
    if (!q) { fail("Enter a sequence of digits to search for."); return; }
    if (!/^[0-9]+$/.test(q)) {
      fail("Use digits 0–9 only. Searches cover the digits after the decimal point (the leading 3 is not included).");
      return;
    }
    if (q.length > total) {
      searchToken++;
      fail("Not found: the sequence is longer than the " + fmt(total) + " digits available.");
      return;
    }
    runSearch(q);
  });

  el.prev.addEventListener("click", function () {
    viewStart = Math.max(0, viewStart - PAGE_SIZE);
    render();
  });

  el.next.addEventListener("click", function () {
    if (viewStart + PAGE_SIZE < total) viewStart += PAGE_SIZE;
    render();
  });

  el.gotoForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = el.gotoInput.value.replace(/[\s,]/g, "");
    if (!/^[0-9]+$/.test(v)) { fail("Enter a position as a whole number, starting at 0."); return; }
    var n = Number(v);
    if (n >= total) { fail("Position out of range: available positions are 0–" + fmt(total - 1) + "."); return; }
    el.result.textContent = "";
    showAt(n);
  });

  // ---- startup ------------------------------------------------------------

  fetch(DATA_DIR + "manifest.json").then(function (res) {
    if (!res.ok) throw new Error("manifest.json: HTTP " + res.status);
    return res.json();
  }).then(function (m) {
    if (!m || !Array.isArray(m.files) || !m.files.length) throw new Error("manifest.json has no files");
    var pos = 0;
    m.files.forEach(function (f) {
      if (f.start !== pos || !(f.length > 0)) {
        throw new Error("manifest.json: " + f.file + " is not contiguous (expected start " + pos + ")");
      }
      pos += f.length;
    });
    if (m.totalDigits !== pos) {
      throw new Error("manifest.json: totalDigits is " + m.totalDigits + " but files add up to " + pos);
    }
    files = m.files;
    total = pos;
    el.available.textContent = fmt(total) + " digits of π after the decimal point are available and searchable " +
      "(" + files.length + " data files, fetched on demand).";
    return render();
  }).catch(function (err) {
    el.available.textContent = "Digit data could not be loaded.";
    fail(err.message + "." + loadingHint());
  });
})();
