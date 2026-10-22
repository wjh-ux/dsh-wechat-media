/**
 * Google Maps, specifically.
 *
 * Why a dedicated module: Maps is unlike the sites `browser_flow` and `browser_capture` are built for. Its first result
 * page is not fetched by XHR at all - the data is embedded in `window.APP_INITIALIZATION_STATE` (167 KB) and a 157 KB
 * inline script - and that structure is compressed coordinate arrays, not objects with names. Measured, not assumed:
 * capture saw only the HTML document, and the biggest array of objects in the state is the state itself.
 *
 * So the reliable thing is the DOM the browser actually renders, driven properly: scroll the feed until it stops
 * growing, collecting every card on the way and de-duplicating by link. The old "60 rows and a cut" was not a limit of
 * Maps; it was three scrolls.
 *
 * The expression is evaluated *in the page*, one async run, so scrolling and waiting happen at page speed rather than
 * across one command per scroll.
 */

/**
 * Build the page-side expression that collects place cards until the feed stops growing.
 *
 * `limit` caps what is collected; `stallRounds` decides when "no growth" means finished (three quiet rounds, because a
 * lazy list often pauses once before loading more).
 */
export function mapsPlacesExpression({ limit = 200, stallRounds = 3, pauseMs = 900, timeoutMs = 90_000 } = {}) {
  return `(async () => {
    const LIMIT = ${Number(limit) || 200};
    const STALL = ${Number(stallRounds) || 3};
    const PAUSE = ${Number(pauseMs) || 900};
    const DEADLINE = Date.now() + ${Number(timeoutMs) || 90_000};

    // The feed appears a moment after navigation. Measured: scrolling before it existed collected 7 rows and stopped,
    // because every scroll was aimed at a list that was not there yet.
    let feed = document.querySelector('div[role="feed"]');
    for (let i = 0; i < 60 && !feed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      feed = document.querySelector('div[role="feed"]');
    }
    const rows = new Map();

    const readCard = (card) => {
      const link = card.querySelector('a[href*="/maps/place/"]');
      if (!link) return null;
      const href = link.href || '';
      const name = (link.getAttribute('aria-label') || link.innerText || '').trim();
      const score = card.querySelector('span[role="img"]');
      const blocks = [...card.querySelectorAll('.W4Efsd')];
      const address = (blocks.length ? blocks[blocks.length - 1].innerText : '').replace(/\\s+/g, ' ').trim();
      return {
        '名称': name,
        '评分': (score?.getAttribute('aria-label') || '').trim(),
        '地址': address,
        '链接': href,
      };
    };

    const collect = () => {
      for (const card of document.querySelectorAll('div[role="feed"] div[role="article"]')) {
        const row = readCard(card);
        if (row && row['名称'] && !rows.has(row['链接'])) rows.set(row['链接'], row);
      }
    };

    collect();
    let quiet = 0;
    let lastSize = rows.size;
    while (rows.size < LIMIT && quiet < STALL && Date.now() < DEADLINE) {
      // The list loads when its *last card* comes into view: setting the feed's scrollTop alone was not enough, and
      // scrolling body did nothing at all - both measured against the live page.
      const cards = document.querySelectorAll('div[role="feed"] div[role="article"]');
      const lastCard = cards[cards.length - 1];
      if (lastCard) lastCard.scrollIntoView({ block: 'end' });
      document.querySelector('div[role="feed"]')?.scrollTo?.({ top: 1e9 });
      await new Promise((resolve) => setTimeout(resolve, PAUSE));
      collect();
      if (rows.size === lastSize) quiet += 1;
      else { quiet = 0; lastSize = rows.size; }
    }

    return [...rows.values()].slice(0, LIMIT);
  })()`;
}

/** The fields the expression returns, so a caller can save them with the same machinery as everything else. */
export const MAPS_FIELDS = Object.freeze({
  名称: "名称",
  评分: "评分",
  地址: "地址",
  链接: "链接",
});
