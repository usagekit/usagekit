import type { ProviderOperation } from "@usagekit/core";

// Endpoint request tables fetched 2026-10-11. A new field is unknown until classified here.
// Neutral fields select/filter/order results within the priced count; none adds a documented fee.
// Price coefficients: https://dataforseo.com/pricing/serp/google-organic-serp-api
// https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api
// https://dataforseo.com/pricing/backlinks/backlinks
export const requestPricing: Readonly<
  Record<string, NonNullable<ProviderOperation["requestPricing"]>>
> = {
  // Request field inventory: https://docs.dataforseo.com/v3/backlinks/backlinks/live/
  "backlinks.backlinks.live": {
    source: "https://docs.dataforseo.com/v3/backlinks/backlinks/live/",
    formula:
      "2.4 + 0.0036 * rowCount cents; summary one row, backlinks limit, history count unknown",
    priceFields: {
      limit: {
        formula: "(base + per-item * limit); documented default, 1..1000; zero unknown",
        defaultCount: 100,
      },
    },
    neutralFields: [
      "target",
      "mode",
      "custom_mode",
      "filters",
      "order_by",
      "offset",
      "search_after_token",
      "backlinks_status_type",
      "include_subdomains",
      "exclude_internal_backlinks",
      "rank_scale",
      "tag",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/backlinks/history/live/
  "backlinks.history.live": {
    source: "https://docs.dataforseo.com/v3/backlinks/history/live/",
    formula:
      "2.4 + 0.0036 * rowCount cents; summary one row, backlinks limit, history count unknown",
    priceFields: {
      date_from: {
        formula: "changes returned row count; count not derivable from the request",
      },
      date_to: {
        formula: "changes returned row count; count not derivable from the request",
      },
    },
    neutralFields: ["target", "rank_scale", "tag"],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/backlinks/summary/live/
  "backlinks.summary.live": {
    source: "https://docs.dataforseo.com/v3/backlinks/summary/live/",
    formula:
      "2.4 + 0.0036 * rowCount cents; summary one row, backlinks limit, history count unknown",
    priceFields: {},
    neutralFields: [
      "target",
      "include_subdomains",
      "include_indirect_links",
      "exclude_internal_backlinks",
      "internal_list_limit",
      "backlinks_status_type",
      "backlinks_filters",
      "rank_scale",
      "tag",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live/
  "dataforseo_labs.google.domain_rank_overview.live": {
    source: "https://docs.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live/",
    formula:
      "(base + perItem * itemCount) * (clickstream ? 2 : 1); historical count unknown; ordinary base 1.2, perItem 0.012 cents; historical base 12, perItem 0.12 cents",
    priceFields: {
      limit: {
        formula: "(base + per-item * limit); documented default, 1..1000; zero unknown",
        defaultCount: 100,
      },
    },
    neutralFields: [
      "target",
      "location_name",
      "location_code",
      "language_name",
      "language_code",
      "ignore_synonyms",
      "offset",
      "tag",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/dataforseo_labs/google/historical_rank_overview/live/
  "dataforseo_labs.google.historical_rank_overview.live": {
    source: "https://docs.dataforseo.com/v3/dataforseo_labs/google/historical_rank_overview/live/",
    formula:
      "(base + perItem * itemCount) * (clickstream ? 2 : 1); historical count unknown; ordinary base 1.2, perItem 0.012 cents; historical base 12, perItem 0.12 cents",
    priceFields: {
      include_clickstream_data: {
        formula: "true doubles entire request charge",
      },
      date_from: {
        formula: "changes returned row count; count not derivable from the request",
      },
      date_to: {
        formula: "changes returned row count; count not derivable from the request",
      },
    },
    neutralFields: [
      "target",
      "location_name",
      "location_code",
      "language_name",
      "language_code",
      "correlate",
      "ignore_synonyms",
      "tag",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live/
  "dataforseo_labs.google.keyword_ideas.live": {
    source: "https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live/",
    formula:
      "(base + perItem * itemCount) * (clickstream ? 2 : 1); historical count unknown; ordinary base 1.2, perItem 0.012 cents; historical base 12, perItem 0.12 cents",
    priceFields: {
      include_clickstream_data: {
        formula: "true doubles entire request charge",
      },
      limit: {
        formula: "(base + per-item * limit); documented default, 1..1000; zero unknown",
        defaultCount: 700,
      },
      offset_token: {
        formula: "unknown: prior task options replace all supplied parameters except limit",
        unpricedWhen: "present",
      },
    },
    neutralFields: [
      "keywords",
      "location_name",
      "location_code",
      "language_name",
      "language_code",
      "closely_variants",
      "ignore_synonyms",
      "include_serp_info",
      "offset",
      "filters",
      "order_by",
      "tag",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live/
  "dataforseo_labs.google.keyword_overview.live": {
    source: "https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live/",
    formula:
      "(base + perItem * itemCount) * (clickstream ? 2 : 1); historical count unknown; ordinary base 1.2, perItem 0.012 cents; historical base 12, perItem 0.12 cents",
    priceFields: {
      keywords: {
        formula: "base + 0.012 cents * keywords.length; clickstream doubles total",
      },
      include_clickstream_data: {
        formula: "true doubles entire request charge",
      },
    },
    neutralFields: [
      "location_name",
      "location_code",
      "language_name",
      "language_code",
      "include_serp_info",
      "tag",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live/
  "dataforseo_labs.google.keyword_suggestions.live": {
    source: "https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live/",
    formula:
      "(base + perItem * itemCount) * (clickstream ? 2 : 1); historical count unknown; ordinary base 1.2, perItem 0.012 cents; historical base 12, perItem 0.12 cents",
    priceFields: {
      include_seed_keyword: {
        formula: "false neutral; true unknown because extra item count is unconfirmed",
        unpricedWhen: "true",
      },
      include_clickstream_data: {
        formula: "true doubles entire request charge",
      },
      limit: {
        formula: "(base + per-item * limit); documented default, 1..1000; zero unknown",
        defaultCount: 100,
      },
      offset_token: {
        formula: "unknown: prior task options replace all supplied parameters except limit",
        unpricedWhen: "present",
      },
    },
    neutralFields: [
      "keyword",
      "location_name",
      "location_code",
      "language_name",
      "language_code",
      "include_serp_info",
      "exact_match",
      "ignore_synonyms",
      "filters",
      "order_by",
      "offset",
      "tag",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live/
  "dataforseo_labs.google.ranked_keywords.live": {
    source: "https://docs.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live/",
    formula:
      "(base + perItem * itemCount) * (clickstream ? 2 : 1); historical count unknown; ordinary base 1.2, perItem 0.012 cents; historical base 12, perItem 0.12 cents",
    priceFields: {
      include_clickstream_data: {
        formula: "true doubles entire request charge",
      },
      limit: {
        formula: "(base + per-item * limit); documented default, 1..1000; zero unknown",
        defaultCount: 100,
      },
    },
    neutralFields: [
      "target",
      "location_name",
      "location_code",
      "language_name",
      "language_code",
      "ignore_synonyms",
      "item_types",
      "offset",
      "load_rank_absolute",
      "historical_serp_mode",
      "filters",
      "order_by",
      "tag",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/dataforseo_labs/google/related_keywords/live/
  "dataforseo_labs.google.related_keywords.live": {
    source: "https://docs.dataforseo.com/v3/dataforseo_labs/google/related_keywords/live/",
    formula:
      "(base + perItem * itemCount) * (clickstream ? 2 : 1); historical count unknown; ordinary base 1.2, perItem 0.012 cents; historical base 12, perItem 0.12 cents",
    priceFields: {
      include_seed_keyword: {
        formula: "false neutral; true unknown because extra item count is unconfirmed",
        unpricedWhen: "true",
      },
      include_clickstream_data: {
        formula: "true doubles entire request charge",
      },
      limit: {
        formula: "(base + per-item * limit); documented default, 1..1000; zero unknown",
        defaultCount: 100,
      },
    },
    neutralFields: [
      "keyword",
      "location_name",
      "location_code",
      "language_name",
      "language_code",
      "depth",
      "include_serp_info",
      "ignore_synonyms",
      "replace_with_core_keyword",
      "filters",
      "order_by",
      "offset",
      "tag",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/dataforseo_labs/google/relevant_pages/live/
  "dataforseo_labs.google.relevant_pages.live": {
    source: "https://docs.dataforseo.com/v3/dataforseo_labs/google/relevant_pages/live/",
    formula:
      "(base + perItem * itemCount) * (clickstream ? 2 : 1); historical count unknown; ordinary base 1.2, perItem 0.012 cents; historical base 12, perItem 0.12 cents",
    priceFields: {
      include_clickstream_data: {
        formula: "true doubles entire request charge",
      },
      limit: {
        formula: "(base + per-item * limit); documented default, 1..1000; zero unknown",
        defaultCount: 100,
      },
    },
    neutralFields: [
      "target",
      "location_name",
      "location_code",
      "language_name",
      "language_code",
      "item_types",
      "offset",
      "historical_serp_mode",
      "ignore_synonyms",
      "filters",
      "order_by",
      "tag",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/
  "serp.google.organic.live.advanced": {
    source: "https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/",
    formula:
      "pages * (base + rectangle surcharge + AI surcharge + 0.015 * clicks) * 5^operatorCount; full base per page; surcharge scaling is a conservative bound",
    priceFields: {
      keyword: {
        formula: "5^n for distinct documented operators after decoding and NFKC; SERP only",
      },
      depth: {
        formula: "ceil(depth / 10), default 10; take max with max_crawl_pages",
      },
      load_async_ai_overview: {
        formula:
          "true adds one base per page before operator multiplication; high task priority uses the larger pricing-table amount",
      },
      max_crawl_pages: {
        formula: "max(ceil(depth / 10), max_crawl_pages)",
      },
      search_param: {
        formula:
          "5^n for distinct documented operators after decoding and NFKC; shared with keyword",
      },
      people_also_ask_click_depth: {
        formula:
          "1..4 clicks at 0.015 cents per click; reserve on every page with operator multiplication",
      },
      calculate_rectangles: {
        formula:
          "true adds one base per page before operator multiplication; high task priority uses the larger pricing-table amount",
      },
      url: {
        formula: "unknown: provider derives other request fields from URL",
        unpricedWhen: "present",
      },
    },
    neutralFields: [
      "location_code",
      "language_code",
      "device",
      "location_name",
      "language_name",
      "os",
      "tag",
      "stop_crawl_on_match",
      "remove_from_url",
      "group_organic_results",
      "browser_screen_width",
      "browser_screen_height",
      "browser_screen_resolution_ratio",
      "location_coordinate",
      "se_domain",
      "target",
      "target_search_mode",
      "find_targets_in",
      "ignore_targets_in",
    ],
  },
  // Request field inventory: https://docs.dataforseo.com/v3/serp/google/organic/task_post/
  "serp.google.organic.task_post": {
    source: "https://docs.dataforseo.com/v3/serp/google/organic/task_post/",
    formula:
      "pages * (base + rectangle surcharge + AI surcharge + 0.015 * clicks) * 5^operatorCount; full base per page; surcharge scaling is a conservative bound",
    priceFields: {
      keyword: {
        formula: "5^n for distinct documented operators after decoding and NFKC; SERP only",
      },
      depth: {
        formula: "ceil(depth / 10), default 10; take max with max_crawl_pages",
      },
      load_async_ai_overview: {
        formula:
          "true adds one base per page before operator multiplication; high task priority uses the larger pricing-table amount",
      },
      priority: {
        formula: "1 normal base 0.06 cents; 2 high base 0.12 cents",
      },
      max_crawl_pages: {
        formula: "max(ceil(depth / 10), max_crawl_pages)",
      },
      search_param: {
        formula:
          "5^n for distinct documented operators after decoding and NFKC; shared with keyword",
      },
      people_also_ask_click_depth: {
        formula:
          "1..4 clicks at 0.015 cents per click; reserve on every page with operator multiplication",
      },
      calculate_rectangles: {
        formula:
          "true adds one base per page before operator multiplication; high task priority uses the larger pricing-table amount",
      },
      url: {
        formula: "unknown: provider derives other request fields from URL",
        unpricedWhen: "present",
      },
    },
    neutralFields: [
      "location_code",
      "language_code",
      "device",
      "pingback_url",
      "postback_url",
      "postback_data",
      "location_name",
      "location_coordinate",
      "language_name",
      "tag",
      "os",
      "stop_crawl_on_match",
      "remove_from_url",
      "expand_ai_overview",
      "group_organic_results",
      "browser_screen_width",
      "browser_screen_height",
      "browser_screen_resolution_ratio",
      "target_search_mode",
      "find_targets_in",
      "ignore_targets_in",
      "se_domain",
    ],
  },
};
