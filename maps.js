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
 * `limit` caps what is collected; `stallRounds` decides when "no growth" means finished. The defaults are the ones the
 * first live runs taught: 900 ms / 3 rounds stopped at 54 places, 1600 ms / 5 rounds reached 83 of the ~94 a single
 * search is willing to show - Maps loads a screen every 1-2 s, so a short wait reads "finished" too early. The deadline
 * was 90 s and cut a search off at 47; a full list needs about two minutes.
 */
export function mapsPlacesExpression({ limit = 200, stallRounds = 5, pauseMs = 1500, timeoutMs = 240_000 } = {}) {
  return `(async () => {
    const LIMIT = ${Number(limit) || 200};
    const STALL = ${Number(stallRounds) || 5};
    const PAUSE = ${Number(pauseMs) || 1500};
    const DEADLINE = Date.now() + ${Number(timeoutMs) || 240_000};

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

      // The card's blocks are not in a fixed order. Measured on a live page, three shapes in three cards:
      //   ["4.6(14)", "咖啡店 · 淮海中路1856号", ...]              - rating as a block
      //   ["5.0(1)", "咖啡馆 … 正在营业 · 结束营业时间：23:00"]     - opening hours where an address would be
      //   and some cards simply have no rating at all (a place with no reviews).
      // So both fields are recognised by what they look like, not by their position.
      const blocks = [...card.querySelectorAll('.W4Efsd')].map((block) => block.innerText.replace(/\\s+/g, ' ').trim());
      const timeish = /营业|打烊|即将|开始|结束|周[一二三四五六日]|分钟|小时/;
      const addressBlock = blocks.find((text) => text.includes(' · ') && !timeish.test(text)) || '';
      const address = addressBlock ? addressBlock.split(' · ').slice(1).join(' · ').trim() : '';

      const labelled = (card.querySelector('span[role="img"]')?.getAttribute('aria-label') || '').trim();
      const numeric = blocks.find((text) => /^\\d(\\.\\d)?\\(\\d+\\)$/.test(text)) || '';

      return {
        '名称': name,
        '评分': labelled || numeric,
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
