// Rebuilds episodes.json from the podcast's RSS feed, so new episodes and edits to old ones both come through.
// It runs on a schedule in the public repository (see .github/workflows/update-feed.yml) and can be run here too.
// It needs nothing installed besides Node 18 or newer.
// Run with: node update-feed.js
const fs = require('fs');
const path = require('path');

const RSS_URL = 'https://anchor.fm/s/d73b7234/podcast/rss';
const OUT = path.join(__dirname, 'episodes.json');
const APPLE_SHOW_ID = '6817450378';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function decode(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCodePoint(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCodePoint(parseInt(n, 16)); })
    .replace(/&amp;/g, '&');
}

// The text inside the first <name>…</name> in a piece of the feed, or '' if there is none.
function field(xml, name) {
  const m = xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'));
  if (!m) return '';
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decode(m[1])).trim();
}

function pad(n) { return String(n).padStart(2, '0'); }

// Tidies a description: drops line breaks left at the end of a paragraph, empty paragraphs, and the feed's own
// link settings (the page sets its own, so links open in a new tab).
function tidy(html) {
  return html
    .replace(/<br\s*\/?>\s*(?=<\/p>)/gi, '')
    .replace(/<p>\s*<\/p>/gi, '')
    .replace(/(<a\s[^>]*?)\s+target="[^"]*"/gi, '$1')
    .replace(/(<a\s[^>]*?)\s+rel="[^"]*"/gi, '$1')
    .trim();
}

// The calendar date in California, where the show is published, so a late-evening release keeps that day's date.
function californiaDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// "00:56:54" becomes "56:54" and "01:00:37" becomes "1:00:37". A plain number is taken as seconds.
function duration(raw) {
  if (!raw) return '';
  let parts = raw.split(':').map(Number);
  if (parts.some(isNaN)) return '';
  if (parts.length === 1) parts = [Math.floor(parts[0] / 3600), Math.floor(parts[0] / 60) % 60, Math.floor(parts[0]) % 60];
  while (parts.length < 3) parts.unshift(0);
  return parts[0] ? parts[0] + ':' + pad(parts[1]) + ':' + pad(parts[2]) : parts[1] + ':' + pad(parts[2]);
}

// Descriptions open with "Originally broadcast on the 23rd of September, 2026", with small variations in older
// episodes ("broadcasted", a missing "on"). Without that, the published date stands in.
function broadcastDate(notes, published) {
  const text = notes.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\u00a0/g, ' ');
  const m = text.match(/broadcast(?:ed)?\s*(?:on)?\s*(?:the)?\s*(\d{1,2})(?:st|nd|rd|th)?\s+of\s+([A-Za-z]+),?\s+(\d{4})/i);
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  return month === -1 ? published : m[3] + '-' + pad(month + 1) + '-' + pad(m[1]);
}

function episode(item) {
  const notes = tidy(field(item, 'description'));
  const published = new Date(field(item, 'pubDate'));
  const publishedDate = isNaN(published) ? '' : californiaDate(published);
  const number = parseInt(field(item, 'itunes:episode'), 10);
  const audio = item.match(/<enclosure\s[^>]*url="([^"]*)"/);
  return {
    id: field(item, 'guid'),
    title: field(item, 'title'),
    episodeNumber: isNaN(number) ? null : number,
    broadcastDate: broadcastDate(notes, publishedDate),
    publishedDate: publishedDate,
    duration: duration(field(item, 'itunes:duration')),
    notes: notes,
    // Filled in by addListenLinks below. The feed's own link goes to Spotify for Creators, not the Spotify app.
    spotifyUrl: '',
    appleUrl: '',
    audioUrl: audio ? decode(audio[1]) : '',
    _creatorsUrl: field(item, 'link')
  };
}

const SPOTIFY_EPISODE = /^https:\/\/open\.spotify\.com\/episode\/[A-Za-z0-9]+$/;
const APPLE_EPISODE = /^https:\/\/podcasts\.apple\.com\/.*[?&]i=\d+/;

// The short code at the end of a Spotify for Creators episode link, like "e3q62mg".
function creatorsCode(url) {
  const m = /-(e[a-z0-9]+)\/?$/.exec(url || '');
  return m ? m[1] : '';
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (center-point-podcast-feed)' } });
  if (!res.ok) throw new Error(url + ' answered ' + res.status);
  return res.text();
}

// Each Spotify for Creators episode page lists that episode and a few others, each with its open.spotify.com link.
function spotifyLinksIn(page) {
  const found = {};
  page.split('"episodeId":"').slice(1).forEach(function (chunk) {
    const code = /^(e[a-z0-9]+)"/.exec(chunk);
    const url = /"spotifyUrl":"([^"]+)"/.exec(chunk);
    if (!code || !url) return;
    const clean = url[1].replace(/\\u002F/gi, '/');
    if (SPOTIFY_EPISODE.test(clean)) found[code[1]] = clean;
  });
  return found;
}

// Gives each episode its own Spotify and Apple Podcasts link. Links found on earlier runs are kept, so only new
// episodes are looked up. An episode that can't be matched keeps an empty link, and the page uses the show's link.
async function addListenLinks(episodes, old) {
  const before = {};
  (old ? old.episodes : []).forEach(function (e) { before[e.id] = e; });
  episodes.forEach(function (e) {
    const prev = before[e.id] || {};
    if (SPOTIFY_EPISODE.test(prev.spotifyUrl || '')) e.spotifyUrl = prev.spotifyUrl;
    if (APPLE_EPISODE.test(prev.appleUrl || '')) e.appleUrl = prev.appleUrl;
  });

  // Apple: one lookup covers the latest 200 episodes, matched on the feed's guid.
  if (episodes.some(function (e) { return !e.appleUrl; })) {
    try {
      const data = JSON.parse(await getText('https://itunes.apple.com/lookup?id=' + APPLE_SHOW_ID + '&entity=podcastEpisode&limit=300'));
      const byGuid = {};
      data.results.forEach(function (r) { if (r.episodeGuid && r.trackViewUrl) byGuid[r.episodeGuid] = r.trackViewUrl.replace(/[?&]uo=\d+/, ''); });
      episodes.forEach(function (e) { if (!e.appleUrl && APPLE_EPISODE.test(byGuid[e.id] || '')) e.appleUrl = byGuid[e.id]; });
    } catch (err) {
      console.warn('Apple Podcasts lookup failed, keeping the links already known: ' + err.message);
    }
  }

  // Older episodes fall outside that lookup, so each one still missing is searched for by title, then matched on guid.
  // Once found, a link is kept, so this only runs for an episode the first time.
  for (const e of episodes) {
    if (e.appleUrl) continue;
    try {
      const query = new URLSearchParams({ term: e.title, media: 'podcast', entity: 'podcastEpisode', limit: '50' });
      const data = JSON.parse(await getText('https://itunes.apple.com/search?' + query));
      const hit = data.results.filter(function (r) { return String(r.collectionId) === APPLE_SHOW_ID && r.episodeGuid === e.id; })[0];
      const url = hit && hit.trackViewUrl ? hit.trackViewUrl.replace(/[?&]uo=\d+/, '') : '';
      if (APPLE_EPISODE.test(url)) e.appleUrl = url;
    } catch (err) {
      console.warn('Apple Podcasts search failed for "' + e.title + '": ' + err.message);
    }
    // Apple's search allows roughly 20 requests a minute.
    await new Promise(function (resolve) { setTimeout(resolve, 3000); });
  }

  // Spotify: open the Creators page of each episode still missing a link (each page also fills in a few neighbours).
  const spotify = {};
  for (const e of episodes) {
    const code = creatorsCode(e._creatorsUrl);
    if (e.spotifyUrl || !code) continue;
    if (!spotify[code]) {
      try {
        Object.assign(spotify, spotifyLinksIn(await getText(e._creatorsUrl)));
      } catch (err) {
        console.warn('Spotify lookup failed for "' + e.title + '": ' + err.message);
      }
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    }
    if (spotify[code]) e.spotifyUrl = spotify[code];
  }

  episodes.forEach(function (e) { delete e._creatorsUrl; });
  const missing = function (key) { return episodes.filter(function (e) { return !e[key]; }).length; };
  console.log('Episode links: ' + missing('spotifyUrl') + ' without Spotify, ' + missing('appleUrl') + ' without Apple Podcasts (those use the show page).');
}

// Episode numbers that really are used twice in the feed. Any other repeat is reported as a problem.
const KNOWN_DUPLICATES = [28];

function duplicateNumbers(episodes) {
  const seen = {};
  const repeats = [];
  episodes.forEach(function (e) {
    if (e.episodeNumber == null) return;
    if (seen[e.episodeNumber] && repeats.indexOf(e.episodeNumber) === -1 && KNOWN_DUPLICATES.indexOf(e.episodeNumber) === -1) repeats.push(e.episodeNumber);
    seen[e.episodeNumber] = true;
  });
  return repeats;
}

function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// The feed is served through a network of servers that each keep their own copy. For a while after an edit in
// Spotify, some still hand out an older or half-updated copy, and adding anything to the address does not get
// around that. So the feed is fetched a few times, and the copy built most recently is used. A copy where two
// episodes share a number is taken as half-updated: the job keeps trying for a little longer before settling.
async function fetchFeed() {
  let best = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    if (attempt > 1) await wait(10000);
    const res = await fetch(RSS_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) { console.log('Try ' + attempt + ': the RSS feed answered ' + res.status); continue; }
    const xml = await res.text();
    const built = new Date(field(xml, 'lastBuildDate'));
    const episodes = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map(episode);
    const repeats = duplicateNumbers(episodes);
    console.log('Try ' + attempt + ': ' + episodes.length + ' episodes, feed built ' + (isNaN(built) ? 'at an unknown time' : built.toISOString()) +
      ', served by ' + (res.headers.get('x-served-by') || 'unknown') + (repeats.length ? ', episode numbers used twice: ' + repeats.join(', ') : ''));
    const copy = { built: isNaN(built) ? 0 : built.getTime(), episodes: episodes, repeats: repeats };
    if (!best || (best.repeats.length && !repeats.length) || (!best.repeats.length === !repeats.length && copy.built > best.built)) best = copy;
    if (attempt >= 3 && !best.repeats.length) break;
  }
  if (!best) throw new Error('The RSS feed could not be loaded');
  return best;
}

async function main() {
  const feed = await fetchFeed();
  const episodes = feed.episodes;

  // A broken or half-loaded feed must never replace good data.
  if (!episodes.length) throw new Error('No episodes found in the RSS feed');
  const broken = episodes.filter(function (e) { return !e.id || !e.title || !e.publishedDate || !e.audioUrl; });
  if (broken.length) throw new Error(broken.length + ' episodes are missing a title, date, or audio; first: ' + JSON.stringify(broken[0]));
  let old = null;
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (err) { /* first run: nothing to compare with */ }
  if (old && episodes.length < old.episodes.length * 0.9) {
    throw new Error('The feed has ' + episodes.length + ' episodes but episodes.json has ' + old.episodes.length + '; not replacing it');
  }

  await addListenLinks(episodes, old);

  if (old && JSON.stringify(old.episodes) === JSON.stringify(episodes)) {
    console.log('episodes.json already matches the RSS feed (' + episodes.length + ' episodes). Nothing to update.');
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), count: episodes.length, episodes: episodes }) + '\n');
  console.log('episodes.json: ' + episodes.length + ' episodes' + (old ? ' (was ' + old.episodes.length + ')' : ''));
}

// Saved data with two episodes sharing a number still goes up, so a new episode is never held back, but the run is
// marked with a warning on GitHub, since it usually means the feed was caught half-updated: run it again in a few minutes.
function warnAboutRepeats() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (err) { return; }
  const repeats = duplicateNumbers(saved.episodes);
  if (!repeats.length) return;
  const message = 'Two episodes share the number ' + repeats.join(', ') + '. The RSS feed was probably caught partway through an edit; run this again in a few minutes. If it keeps happening, check the episode numbers in Spotify.';
  console.log(process.env.GITHUB_ACTIONS ? '::warning::' + message : 'Warning: ' + message);
}

main().then(warnAboutRepeats).catch(function (err) { console.error(err.message); process.exit(1); });
