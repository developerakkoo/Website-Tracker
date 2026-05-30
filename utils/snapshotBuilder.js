(function (global) {
  'use strict';

  function stripScripts(html) {
    return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  }

  function stripUnsafeAttrs(html) {
    return html
      .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+integrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  }

  function collectInlineStyles() {
    var css = '';
    try {
      var sheets = document.styleSheets;
      for (var i = 0; i < sheets.length; i++) {
        try {
          var rules = sheets[i].cssRules || sheets[i].rules;
          if (!rules) continue;
          for (var j = 0; j < rules.length; j++) {
            css += rules[j].cssText + '\n';
          }
        } catch (e) {
          /* cross-origin stylesheet */
        }
      }
    } catch (e) {}
    return css;
  }

  function baseDirectoryUrl(href) {
    if (!href) return '';
    if (href.endsWith('/')) return href;
    var idx = href.lastIndexOf('/');
    return idx >= 0 ? href.slice(0, idx + 1) : href + '/';
  }

  function injectIntoHead(html, injection) {
    if (html.indexOf('<head') !== -1) {
      return html.replace(/<head[^>]*>/i, function (m) {
        return m + injection;
      });
    }
    return '<head>' + injection + '</head>' + html;
  }

  function toAbsoluteUrl(value, pageUrl) {
    if (!value || typeof value !== 'string') return value;
    var trimmed = value.trim();
    if (
      !trimmed ||
      trimmed.indexOf('data:') === 0 ||
      trimmed.indexOf('blob:') === 0 ||
      trimmed.indexOf('javascript:') === 0 ||
      trimmed.indexOf('#') === 0
    ) {
      return value;
    }
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    try {
      return new URL(trimmed, pageUrl).href;
    } catch (e) {
      return value;
    }
  }

  function rewriteRelativeUrls(html, pageUrl) {
    var attrs = ['href', 'src', 'srcset', 'poster'];
    attrs.forEach(function (attr) {
      var re = new RegExp('(\\s' + attr + '\\s*=\\s*)(["\'])([^"\']*)\\2', 'gi');
      html = html.replace(re, function (_m, prefix, quote, url) {
        return prefix + quote + toAbsoluteUrl(url, pageUrl) + quote;
      });
    });
    return html;
  }

  function buildEnrichedSnapshot() {
    var pageUrl = window.location.href;
    var raw = document.documentElement.outerHTML;
    var html = stripUnsafeAttrs(stripScripts(raw));
    html = rewriteRelativeUrls(html, pageUrl);
    var inlineCss = collectInlineStyles();

    if (inlineCss) {
      html = injectIntoHead(
        html,
        '<style data-wt-inlined="true">' + inlineCss + '</style>'
      );
    }

    var baseDir = baseDirectoryUrl(pageUrl);
    var safeBase = baseDir.replace(/"/g, '&quot;');
    html = injectIntoHead(html, '<base href="' + safeBase + '">');

    return html;
  }

  global.__wtBuildSnapshot = buildEnrichedSnapshot;
})(typeof window !== 'undefined' ? window : this);
