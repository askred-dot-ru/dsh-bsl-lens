/**
 * BSL Lens — client half.
 *
 * Registers one document preview implementation for 1C:Enterprise module files:
 * the metadata goes into `ctx.documentPreviews`, the body into the keyed,
 * session-scoped `sidebar.right.tab.document` slot under the same id. Open a
 * `.bsl` file in the Sidebar (the Files tab, a file link, or a `read` row's
 * path) and this body renders it line-numbered with 1C tokens instead of plain
 * text.
 *
 * The shipped highlighter in `dsh-client-ui-primitives` owns a fixed TextMate
 * allowlist with no registration API (`LANG_ALIASES` is module-private and the
 * module namespace is frozen), and Shiki ships no 1C grammar. So this bundle
 * carries its own scanner — a few hundred lines, no dependency — and paints
 * tokens with the theme's own `--shiki-token-*` custom properties, which is why
 * colours follow light/dark automatically.
 *
 * React, and the optional copy helper, come from the frozen browser module
 * table; no Harness Client package is imported at build time.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bsl-lens',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    // Only `createPortal` is used: the preview dialog must escape the pane's clip.
    let reactDom = null;
    try {
      reactDom = require('react-dom');
    } catch {
      reactDom = null;
    }

    /** Implementation identity: the registry id, and the body's slot key. */
    const ID = 'dsh-bsl-lens';
    /** Dictionary namespace owned by this plugin. */
    const NS = 'bslHighlight';
    /** Suffixes claimed. `.bsl` is the module source; `.1c` appears in shared snippets. */
    const EXTENSIONS = ['bsl', '1c'];

    // ── 1C token tables ──────────────────────────────────────────────────────

    /** Language keywords, Russian and English spellings, case-insensitive. */
    const KEYWORDS = new Set([
      // Declarations and blocks.
      'процедура', 'конецпроцедуры', 'функция', 'конецфункции',
      'перем', 'знач', 'экспорт', 'возврат',
      'если', 'тогда', 'иначе', 'иначеесли', 'конецесли',
      'для', 'каждого', 'из', 'по', 'пока', 'цикл', 'конеццикла',
      'попытка', 'исключение', 'конецпопытки', 'вызватьисключение',
      'перейти', 'продолжить', 'прервать', 'ждать', 'асинх',
      'новый', 'выполнить',
      'добавитьобработчик', 'удалитьобработчик',
      // Operators and directives.
      'не', 'и', 'или', 'вызовсервера',
      // English spellings.
      'procedure', 'endprocedure', 'function', 'endfunction',
      'var', 'val', 'export', 'return',
      'if', 'then', 'else', 'elsif', 'endif',
      'for', 'each', 'in', 'to', 'while', 'do', 'enddo',
      'try', 'except', 'endtry', 'raise',
      'goto', 'continue', 'break', 'await', 'async',
      'new', 'execute', 'addhandler', 'removehandler',
      'not', 'and', 'or',
    ]);

    /** Literal constants: they read as values, not as keywords. */
    const CONSTANTS = new Set([
      'истина', 'ложь', 'неопределено', 'null',
      'true', 'false', 'undefined',
    ]);

    /** Global manager collections: `Справочники.Товары`, `Документы.Заказ`. */
    const COLLECTIONS = new Set([
      'константы', 'справочники', 'документы', 'журналыдокументов', 'перечисления',
      'планывидовхарактеристик', 'планысчетов', 'планывидоврасчета', 'планыобмена',
      'регистрысведений', 'регистрынакопления', 'регистрыбухгалтерии', 'регистрырасчета',
      'бизнеспроцессы', 'задачи', 'отчеты', 'обработки',
      'последовательности', 'критерииотбора', 'внешниеисточникиданных',
      'constants', 'catalogs', 'documents', 'documentjournals', 'enums',
      'chartsofcharacteristictypes', 'chartsofaccounts', 'chartsofcalculationtypes',
      'exchangeplans', 'informationregisters', 'accumulationregisters',
      'accountingregisters', 'calculationregisters', 'businessprocesses',
      'tasks', 'reports', 'dataprocessors', 'sequences', 'filtercriteria',
      'externaldatasources',
    ]);

    /**
     * Prefixes of generated metadata type names: `СправочникСсылка.Товары`,
     * `ДокументОбъект.Заказ`, `РегистрСведенийНаборЗаписей.Цены`. Matched
     * case-insensitively after requiring an uppercase first letter, so a
     * camelCase local named `documentText` stays plain.
     */
    const TYPE_PREFIXES = [
      'справочник', 'документ', 'регистрсведений', 'регистрнакопления',
      'регистрбухгалтерии', 'регистррасчета', 'плансчетов',
      'планвидовхарактеристик', 'планвидоврасчета', 'планобмена',
      'перечисление', 'отчет', 'обработка', 'задача', 'бизнеспроцесс',
      'журналдокументов', 'константа', 'последовательность', 'критерийотбора',
      'внешнийисточникданных', 'catalog', 'document', 'informationregister',
      'accumulationregister', 'accountingregister', 'calculationregister',
      'chartofaccounts', 'chartofcharacteristictypes', 'chartofcalculationtypes',
      'exchangeplan', 'enum', 'report', 'dataprocessor', 'task',
      'businessprocess', 'documentjournal', 'constant', 'sequence',
      'externaldatasource',
    ];

    /** Identifier: letters (any script) and underscore, then digits allowed. */
    const IDENTIFIER = /[\p{L}_][\p{L}\p{Nd}_]*/uy;
    /** Single-character start test, kept unsticky so no lastIndex state leaks. */
    const IDENTIFIER_START = /^[\p{L}_]$/u;
    /** Number: optional fraction and exponent. */
    const NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
    /** Horizontal whitespace only — a newline is its own event. */
    const HORIZONTAL_SPACE = /[ \t\f\v\u00a0\r]+/uy;
    /** Uppercase first letter gate for type-name heuristics. */
    const UPPERCASE_START = /^\p{Lu}/u;
    /** Whitespace-only prefix, for "a directive may start here". */
    const BLANK_PREFIX = /^[ \t]*$/u;

    /**
     * Whether an identifier is a generated metadata type name.
     * @param word - the source identifier.
     * @returns true for `СправочникСсылка`, `Documents`, `CatalogRef`.
     */
    function looksLikeTypeName(word) {
      if (!UPPERCASE_START.test(word)) return false;
      const lower = word.toLowerCase();
      for (const prefix of TYPE_PREFIXES) {
        if (lower.length > prefix.length && lower.startsWith(prefix)) return true;
      }
      return false;
    }

    /**
     * Classify one identifier against the look-behind/look-ahead facts.
     * @param word - source identifier.
     * @param state - whether a `.` or `Новый` precedes it, and whether `(` follows.
     * @returns the token class.
     */
    function classifyIdentifier(word, state) {
      const lower = word.toLowerCase();
      // After a dot the identifier is a member: `Запрос.Выполнить()` is a method
      // call, not the keyword of the same spelling.
      if (state.afterDot) return 'fn';
      if (KEYWORDS.has(lower)) return 'kw';
      if (CONSTANTS.has(lower)) return 'con';
      if (state.afterNew) return 'type';
      if (COLLECTIONS.has(lower) || looksLikeTypeName(word)) return 'type';
      if (state.call) return 'fn';
      return 'id';
    }

    /**
     * The next significant character after `index`, for call detection.
     * @param source - whole document.
     * @param index - position after the identifier.
     * @returns the next non-space character, or '' at end of input.
     */
    function nextSignificant(source, index) {
      let cursor = index;
      while (cursor < source.length) {
        const character = source[cursor];
        if (character !== ' ' && character !== '\t') return character;
        cursor += 1;
      }
      return '';
    }

    /**
     * Scan 1C:Enterprise (BSL) source into per-line token spans.
     *
     * The scanner is hand-written because no 1C grammar exists in the shipped
     * highlighter: it covers comments, `""`-escaped (possibly multi-line)
     * strings, `'20240101'` date literals, numbers, `#Область`-style directives,
     * `&НаКлиенте` annotations, keywords, metadata type names, call sites and
     * punctuation. It never throws: anything unrecognised is plain text.
     *
     * @param source - the file text.
     * @returns one entry per source line, each a list of `{ t, s }` spans, where
     * `t` is a token class and `s` its text.
     */
    function tokenizeBsl(source) {
      /** @type {Array<Array<{ t: string, s: string }>>} */
      const lines = [[]];
      let line = lines[0];

      /**
       * Append text, splitting on newlines so one token may span lines (a
       * multi-line string literal).
       * @param type - token class.
       * @param text - token text, possibly containing newlines.
       */
      const push = (type, text) => {
        if (text === '') return;
        const parts = text.split('\n');
        for (let part = 0; part < parts.length; part += 1) {
          if (part > 0) {
            line = [];
            lines.push(line);
          }
          const piece = parts[part];
          if (piece === '') continue;
          const last = line[line.length - 1];
          if (last !== undefined && last.t === type) last.s += piece;
          else line.push({ t: type, s: piece });
        }
      };

      /** Look-behind facts kept by {@link emit}. */
      let afterDot = false;
      let afterNew = false;

      /**
       * Emit a token and update the look-behind facts.
       * @param type - token class.
       * @param text - token text.
       */
      const emit = (type, text) => {
        push(type, text);
        if (type === 'txt') return;
        if (type === 'pun' && text === '.') {
          afterDot = true;
          afterNew = false;
          return;
        }
        const lower = text.toLowerCase();
        afterNew = type === 'kw' && (lower === 'новый' || lower === 'new');
        afterDot = false;
      };

      let index = 0;
      while (index < source.length) {
        const character = source[index];

        // `//` line comment: consumes the rest of the line, never the newline.
        if (character === '/' && source[index + 1] === '/') {
          let end = source.indexOf('\n', index);
          if (end === -1) end = source.length;
          emit('com', source.slice(index, end));
          index = end;
          continue;
        }

        // String literal: `""` is an escaped quote, and a literal may continue
        // across lines (the continuation `|` stays inside the token).
        if (character === '"') {
          let end = index + 1;
          let closed = false;
          while (end < source.length) {
            if (source[end] === '"') {
              if (source[end + 1] === '"') {
                end += 2;
                continue;
              }
              end += 1;
              closed = true;
              break;
            }
            end += 1;
          }
          emit('str', source.slice(index, closed ? end : source.length));
          index = closed ? end : source.length;
          continue;
        }

        // Date literal: '20240101120000'.
        if (character === "'") {
          const closing = source.indexOf("'", index + 1);
          const end = closing === -1 ? source.length : closing + 1;
          emit('num', source.slice(index, end));
          index = end;
          continue;
        }

        // `#Область` / `#Если`: a directive only where one may start.
        if (character === '#') {
          const lineBegin = source.lastIndexOf('\n', index - 1) + 1;
          if (BLANK_PREFIX.test(source.slice(lineBegin, index))) {
            IDENTIFIER.lastIndex = index + 1;
            const word = IDENTIFIER.exec(source);
            const end = word === null ? index + 1 : IDENTIFIER.lastIndex;
            emit('ann', source.slice(index, end));
            index = end;
            continue;
          }
          emit('pun', character);
          index += 1;
          continue;
        }

        // `&НаКлиенте` / `&Вместо`: a compilation annotation.
        if (character === '&') {
          IDENTIFIER.lastIndex = index + 1;
          const word = IDENTIFIER.exec(source);
          if (word !== null) {
            emit('ann', source.slice(index, IDENTIFIER.lastIndex));
            index = IDENTIFIER.lastIndex;
            continue;
          }
          emit('pun', character);
          index += 1;
          continue;
        }

        // Number literal.
        if (character >= '0' && character <= '9') {
          NUMBER.lastIndex = index;
          const number = NUMBER.exec(source);
          const end = number === null ? index + 1 : NUMBER.lastIndex;
          emit('num', source.slice(index, end));
          index = end;
          continue;
        }

        // Identifier or keyword.
        if (IDENTIFIER_START.test(character)) {
          IDENTIFIER.lastIndex = index;
          const word = IDENTIFIER.exec(source);
          const text = word === null ? character : word[0];
          const end = index + text.length;
          emit(classifyIdentifier(text, {
            afterDot,
            afterNew,
            call: nextSignificant(source, end) === '(',
          }), text);
          index = end;
          continue;
        }

        // A newline starts a new source line.
        if (character === '\n') {
          push('txt', '\n');
          index += 1;
          afterDot = false;
          afterNew = false;
          continue;
        }

        // Horizontal whitespace carries no style and must not disturb look-behind.
        if (character === ' ' || character === '\t' || character === '\r'
          || character === '\f' || character === '\v' || character === '\u00a0') {
          HORIZONTAL_SPACE.lastIndex = index;
          const space = HORIZONTAL_SPACE.exec(source);
          const end = space === null ? index + 1 : HORIZONTAL_SPACE.lastIndex;
          push('txt', source.slice(index, end));
          index = end;
          continue;
        }

        // Two-character comparison operators, then single punctuation.
        const pair = source.slice(index, index + 2);
        if (pair === '<>' || pair === '<=' || pair === '>=') {
          emit('pun', pair);
          index += 2;
          continue;
        }
        emit('pun', character);
        index += 1;
      }

      // A file closing with a newline ends on an empty line no editor shows.
      if (source.endsWith('\n') && lines.length > 1) {
        const last = lines[lines.length - 1];
        if (last.length === 0) lines.pop();
      }

      return lines;
    }

    // ── Presentation ─────────────────────────────────────────────────────────

    /**
     * The 1C:Enterprise Configurator's standard syntax scheme, as its own
     * settings dialog offers it (Configuration → Параметры → Модули → Редактирование →
     * «Выделение цветом синтаксических конструкций»), and as its `.csi` colour-scheme
     * files spell the categories out: Keywords, Numerics, Strings, Dates,
     * Identifiers, Operators, Comments, Preprocessor, Others, Background.
     *
     * The preview is deliberately a light surface even in a dark application:
     * these colours are the Configurator's, they assume a white page, and they
     * are what a 1C developer reads every day. Nothing here follows the app
     * theme, so neither the palette nor the background is read from a token.
     */
    const CONFIGURATOR = {
      /** `Ключевые слова` — red. */
      keyword: '#ff0000',
      /** `Константы типа «Число»/«Строка»/«Дата»` — black, i.e. plain text. */
      constant: '#000000',
      /** `Идентификаторы` — blue: every name, member and type. */
      identifier: '#0000ff',
      /** `Операторы` — red, same as keywords. */
      operator: '#ff0000',
      /** `Комментарии` — green. */
      comment: '#008000',
      /** `Препроцессор` — brown: `#Область`, `#Если`, and `&НаКлиенте` annotations. */
      preprocessor: '#963200',
      /** `Прочее` — black. */
      other: '#000000',
      /** `Фон` — white. */
      background: '#ffffff',
    };

    /**
     * Token class to inline style, projected onto the Configurator palette.
     *
     * Two deliberate merges: metadata type names and calls are `Идентификаторы`
     * like any other name (the Configurator has no separate type colour), and
     * `Истина`/`Ложь`/`Неопределено` are reserved words, so they read as
     * `Ключевые слова` rather than as lexical constants.
     */
    const TOKEN_STYLE = {
      kw: { color: CONFIGURATOR.keyword },
      con: { color: CONFIGURATOR.keyword },
      id: { color: CONFIGURATOR.identifier },
      type: { color: CONFIGURATOR.identifier },
      fn: { color: CONFIGURATOR.identifier },
      num: { color: CONFIGURATOR.constant },
      str: { color: CONFIGURATOR.constant },
      com: { color: CONFIGURATOR.comment },
      ann: { color: CONFIGURATOR.preprocessor },
      pun: { color: CONFIGURATOR.operator },
    };

    /**
     * Plugin-private class prefix, so nothing collides with another plugin's CSS.
     *
     * Every value is a literal, not a theme token: the pane keeps the
     * Configurator's white page and its light chrome even when the application
     * runs in dark mode. `color-scheme: light` makes the native scrollbars and
     * the text-selection colours light inside this element only.
     */
    const CSS = [
      '.bslh-root{box-sizing:border-box;display:flex;flex-direction:column;flex:1 1 auto;width:100%;min-width:0;min-height:0;overflow:hidden;background:#ffffff;color:#000000;color-scheme:light;--dsh-scrollbar-thumb:#c9c9c9;--dsh-scrollbar-thumb-hover:#adadad}',
      '.bslh-bar{box-sizing:border-box;display:flex;flex:none;align-items:center;justify-content:space-between;gap:12px;padding:9px 14px 8px 16px;background:#f4f4f4;border-bottom:1px solid #dbdbdb;color:#3c3c3c;font:11px/18px var(--dsw-font-family)}',
      '.bslh-heading{display:flex;align-items:center;gap:10px;min-width:0}',
      '.bslh-lang{flex:none;color:#6b6b6b;font-family:var(--ds-font-family-code)}',
      '.bslh-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8a8a8a}',
      '.bslh-actions{display:flex;flex:none;align-items:center;gap:4px}',
      '.bslh-copy{display:inline-flex;align-items:center;height:22px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:#3c3c3c;cursor:pointer;font:inherit}',
      '.bslh-copy:hover{background:#e4e4e4;color:#000000}',
      '.bslh-copy:focus-visible{outline:1px solid #0b6bcb;outline-offset:1px}',
      '.bslh-scroll{flex:auto;min-width:0;min-height:0;overflow:auto;background:#ffffff}',
      // The application theme may carry its own ::selection colours; on a white page they can
      // render dark-on-dark, so this pane pins the light pair.
      '.bslh-root ::selection{background:#b5d7fd;color:#000000}',
      '.bslh-scroll::-webkit-scrollbar-track{margin:2px}',
      '.bslh-pre{box-sizing:border-box;margin:0;padding:16px;font:var(--dsw-font-markdown-code-block);min-width:100%}',
      '.bslh-line{display:flex;align-items:flex-start;min-height:19px;min-height:1lh}',
      '.bslh-gutter{box-sizing:content-box;flex:none;width:var(--bslh-gutter,3ch);padding-right:14px;color:#8a8a8a;text-align:right;user-select:none;-webkit-user-select:none}',
      '.bslh-text{flex:1;min-width:0;white-space:pre;tab-size:2}',
      '.bslh-root[data-wrap=true] .bslh-text{white-space:pre-wrap;overflow-wrap:anywhere}',
      '.bslh-empty{padding:16px;color:#6b6b6b;font:var(--dsw-font-markdown-code-block)}',
      // The 1C palette is bright, so a jump target needs a light wash to read.
      '.bslh-line[data-target=true]{background:#fff3c4}',
      // A routine block carries no frame of its own: it is structure plus the
      // "you are here" accent after a jump. The visible frame belongs to a
      // *reference* to another routine inside the code.
      '.bslh-routine{position:relative;margin:3px 0;border-radius:3px}',
      '.bslh-routine[data-current=true]{box-shadow:inset 3px 0 0 #0b6bcb;background:#f7fafd}',
      '.bslh-ref{border-radius:3px;background:#dcebfc;outline:1px solid #8fb7e4;outline-offset:1px;cursor:pointer}',
      '.bslh-ref:hover{background:#cbe2fb;outline-color:#4f8fd6}',
      // A call into another module: violet, resolved through cfsmcp2 on click.
      '.bslh-ext{border-radius:3px;background:#f0e4fb;outline:1px solid #b183e0;outline-offset:1px;color:#5b2a86 !important;cursor:pointer}',
      '.bslh-ext:hover{background:#e7d5fa;outline-color:#8d4fd0}',
      '.bslh-ext[data-loading=true]{opacity:.6}',
      '.bslh-tool[disabled]{opacity:.35;cursor:default}',
      '.bslh-tool[disabled]:hover{background:transparent;color:#3c3c3c}',
      // «Назад» is the corner action of every surface: visible at rest, not just on hover.
      '.bslh-back{display:inline-flex;flex:none;align-items:center;gap:5px;height:24px;padding:0 9px 0 7px;border:1px solid #9dbfe4;border-radius:5px;background:#e3effd;color:#0b4f9c;cursor:pointer;font:11px/18px var(--dsw-font-family)}',
      '.bslh-back:hover:not(:disabled){background:#d0e5fb;border-color:#6fa3dc}',
      '.bslh-back:focus-visible{outline:1px solid #0b6bcb;outline-offset:1px}',
      '.bslh-back:disabled{border-color:#dcdcdc;background:#f2f2f2;color:#a0a0a0;cursor:default}',
      '.bslh-back-icon{display:inline-flex;flex:none}',
      '.bslh-dialog-head-left{display:flex;align-items:center;gap:10px;min-width:0}',
      '.bslh-tool{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:#3c3c3c;cursor:pointer}',
      '.bslh-tool:hover{background:#e4e4e4;color:#000000}',
      '.bslh-tool:focus-visible{outline:1px solid #0b6bcb;outline-offset:1px}',
      // The navigation button is the way into the routine list and the call trees:
      // it wears the same bright chip as «Назад» so it reads as an action, and it
      // stays filled while its dialog is open.
      '.bslh-navbtn{display:inline-flex;flex:none;align-items:center;justify-content:center;width:30px;height:24px;padding:0;border:1px solid #9dbfe4;border-radius:5px;background:#e3effd;color:#0b4f9c;cursor:pointer}',
      '.bslh-navbtn:hover{background:#d0e5fb;border-color:#6fa3dc;color:#0b3f7d}',
      '.bslh-navbtn:focus-visible{outline:1px solid #0b6bcb;outline-offset:1px}',
      '.bslh-navbtn[aria-expanded=true]{background:#c9e0fb;border-color:#4f8fd6;color:#0b3f7d;box-shadow:inset 0 0 0 1px #b8d4f2}',
      // ── «Процедуры и функции» ──
      // A light dialog on a light page, so the whole 1C view reads as one
      // object; `color-scheme: light` keeps its scrollbars and carets light too.
      '.bslh-modal{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.34);color-scheme:light}',
      '.bslh-dialog{display:flex;flex-direction:column;width:min(520px,100%);max-height:min(70vh,560px);background:#ffffff;color:#000000;border:1px solid #b5b5b5;border-radius:6px;box-shadow:0 18px 48px rgba(0,0,0,.28);font:13px/1.4 var(--dsw-font-family);overflow:hidden}',
      // Full screen, and always the same box: the code pane scrolls inside it,
      // so choosing a long or a short routine cannot change the dialog's size.
      '.bslh-dialog-wide{width:100%;height:100%;max-width:none;max-height:none}',
      '.bslh-dialog-head{display:flex;flex:none;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px 8px 14px;background:#f0f0f0;border-bottom:1px solid #d6d6d6}',
      '.bslh-dialog-title{font-weight:600}',
      '.bslh-dialog-close{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:4px;background:transparent;color:#3c3c3c;cursor:pointer;font:16px/1 var(--dsw-font-family)}',
      '.bslh-dialog-close:hover{background:#e0e0e0;color:#000000}',
      '.bslh-dialog-close:focus-visible{outline:1px solid #0b6bcb;outline-offset:1px}',
      '.bslh-dialog-main{display:flex;flex:1;gap:10px;min-height:0;padding:10px;overflow:hidden}',
      '.bslh-symbols{flex:1;min-width:0;min-height:0;margin:0;padding:2px;list-style:none;overflow:auto;background:#ffffff;border:1px solid #c9c9c9;outline:none}',
      '.bslh-symbols:focus-visible{border-color:#0b6bcb}',
      '.bslh-symbol{display:flex;align-items:center;gap:8px;padding:3px 8px;cursor:default;user-select:none;-webkit-user-select:none}',
      '.bslh-symbol[data-active=true]{background:#cfe3fb}',
      '.bslh-badge{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px;border-radius:3px;background:#e7e7e7;color:#3c3c3c;font:10px/1 var(--ds-font-family-code)}',
      '.bslh-badge[data-kind=function]{background:#e2eede;color:#2c5c22}',
      '.bslh-symbol-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code);color:#0000ff}',
      '.bslh-symbol-export{flex:none;color:#8a8a8a;font-size:11px}',
      '.bslh-symbol-line{flex:none;color:#8a8a8a;font:11px/1 var(--ds-font-family-code)}',
      '.bslh-dialog-side{display:flex;flex:none;flex-direction:column;gap:8px;width:134px}',
      '.bslh-button{height:26px;padding:0 10px;border:1px solid #b5b5b5;border-radius:4px;background:#f6f6f6;color:#000000;cursor:pointer;font:inherit}',
      '.bslh-button:hover{background:#eaeaea}',
      '.bslh-button:focus-visible{outline:1px solid #0b6bcb;outline-offset:1px}',
      '.bslh-button[data-primary=true]{border-color:#7aa7d8;background:#dce9f9}',
      '.bslh-button[data-primary=true]:hover{background:#cfe0f6}',
      '.bslh-sort{display:flex;align-items:center;gap:6px;margin-top:2px;font-size:12px;color:#3c3c3c;cursor:pointer}',
      '.bslh-help{margin:0 10px 10px;padding:8px 10px;background:#f7f7f7;border:1px solid #d6d6d6;color:#3c3c3c;font-size:12px;line-height:1.45;white-space:pre-line}',
      '.bslh-status{padding:10px 4px;color:#6b6b6b}',
      // ── two panes: the list/tree, and the selected routine's source ──
      '.bslh-pane-left{display:flex;flex:none;flex-direction:column;width:clamp(260px,26vw,420px);min-width:0;min-height:0}',
      '.bslh-pane-code{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;border:1px solid #c9c9c9;background:#ffffff;overflow:hidden}',
      '.bslh-pane-caption{display:flex;flex:none;align-items:center;gap:8px;padding:5px 10px;background:#f4f4f4;border-bottom:1px solid #dcdcdc;color:#3c3c3c;font:11px/16px var(--dsw-font-family)}',
      '.bslh-preview-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0000ff;font-family:var(--ds-font-family-code)}',
      '.bslh-preview-range{flex:none;color:#8a8a8a;font-family:var(--ds-font-family-code)}',
      '.bslh-pane-scroll{flex:1;min-height:0;overflow:auto;background:#ffffff}',
      '.bslh-pre-pane{padding:10px 12px}',
      '.bslh-dialog-foot{display:flex;flex:none;align-items:center;gap:8px;padding:0 10px 10px}',
      '.bslh-foot-spacer{flex:1}',
      // ── «Взаимосвязи» (дерево вызовов) ──
      // The tabs are the dialog's whole navigation: list, calls, called by.
      '.bslh-tabs{display:flex;flex:none;align-items:stretch;gap:0;border:1px solid #b5b5b5;border-radius:5px;overflow:hidden;background:#f6f6f6}',
      '.bslh-tab{height:26px;padding:0 14px;border:0;background:transparent;color:#3c3c3c;cursor:pointer;font:inherit;white-space:nowrap}',
      '.bslh-tab+ .bslh-tab{border-left:1px solid #dcdcdc}',
      '.bslh-tab:hover{background:#ececec}',
      '.bslh-tab[data-active=true]{background:#dce9f9;color:#000000;font-weight:600;box-shadow:inset 0 -2px 0 #0b6bcb}',
      '.bslh-tab:focus-visible{outline:1px solid #0b6bcb;outline-offset:-2px}',
      '.bslh-ext-name{margin-left:8px;color:#5b2a86;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.bslh-foot-note{align-self:center;color:#8a8a8a;font-size:11px}',
      '.bslh-pane-left:focus{outline:none}',
      '.bslh-tree{flex:1;min-width:0;min-height:0;margin:0;padding:2px 0;list-style:none;overflow:auto;background:#ffffff;border:1px solid #c9c9c9;outline:none}',
      '.bslh-tree:focus-visible{border-color:#0b6bcb}',
      // Faint vertical guides across the indent make the nesting readable; the
      // row's depth is a custom property, so the guides are pure CSS.
      '.bslh-tree-row{display:flex;align-items:center;gap:6px;padding:2px 8px 2px 0;cursor:default;user-select:none;-webkit-user-select:none;white-space:nowrap;background-image:repeating-linear-gradient(to right,#e6e6e6 0 1px,transparent 1px 16px);background-position:8px 0;background-repeat:no-repeat;background-size:calc(var(--bslh-depth,0) * 16px) 100%}',
      '.bslh-tree-row[data-active=true]{background:#cfe3fb}',
      '.bslh-twisty{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:3px;background:transparent;color:#5c5c5c;cursor:pointer;font:10px/1 var(--ds-font-family-code)}',
      '.bslh-twisty:hover{background:#e4e4e4}',
      '.bslh-twisty:focus-visible{outline:1px solid #0b6bcb;outline-offset:1px}',
      '.bslh-twisty[data-empty=true]{cursor:default;color:transparent}',
      '.bslh-tree-count{flex:none;color:#8a8a8a;font-size:11px}',
      '.bslh-cycle{flex:none;color:#8a8a8a;font-size:11px}',
    ].join('');

    /** Style element id, so a reloaded bundle never stacks duplicates. */
    const STYLE_ID = 'dsh-bsl-lens/preview.css';

    /** Install the plugin's stylesheet once per document. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) {
        return () => {};
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-bsl-lens';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    /**
     * Put keyboard focus on an element when it can take it.
     *
     * Closing a dialog must return the reader to the control that opened it:
     * otherwise focus falls to `document.body` and the next Tab restarts from
     * the top of the window.
     *
     * @param node - the element to focus, possibly absent.
     * @returns whether focus was moved.
     */
    function focusElement(node) {
      if (node === null || node === undefined) return false;
      if (typeof node.focus !== 'function') return false;
      node.focus();
      return true;
    }

    /**
     * Copy the source text, preferring the shared clipboard helper.
     * @param text - whole document text.
     * @returns whether the write succeeded.
     */
    function copyText(text) {
      if (typeof primitives.writeClipboard === 'function') return primitives.writeClipboard(text);
      try {
        return navigator.clipboard.writeText(text).then(() => true, () => false);
      } catch {
        return Promise.resolve(false);
      }
    }

    /**
     * Render one line: its gutter number and its painted runs. Plain runs stay
     * bare strings so a line without tokens costs no extra elements.
     *
     * A bare call to a routine of this module becomes a framed reference: a light
     * box around the name that navigates to the declaration on a click. A member
     * call (`Объект.Метод()`) never does — that is another object's method, even
     * when this module happens to declare the same name.
     *
     * @param spans - the line's token spans.
     * @param number - 1-based source line number.
     * @param hooks - optional `lookup(name)`/`go(symbol)` pair for references.
     * @returns the line element.
     */
    function renderLine(spans, number, hooks) {
      const children = [];
      let previous = null;
      for (let index = 0; index < spans.length; index += 1) {
        const span = spans[index];
        const style = TOKEN_STYLE[span.t];
        // A call into another module is one reference across three tokens:
        // the module name, the dot and the routine name.
        if (hooks !== undefined && hooks.external !== undefined && span.t === 'id') {
          const dot = spans[index + 1];
          const called = spans[index + 2];
          const external = dot !== undefined && called !== undefined
            && dot.t === 'pun' && dot.s === '.'
            && called.t === 'fn'
            && hooks.external.lookup(span.s, called.s) !== undefined;
          if (external) {
            const request = { module: span.s, method: called.s };
            children.push(h('span', {
              key: `ext:${index}`,
              className: 'bslh-ext',
              'data-ext': `${span.s}.${called.s}`,
              role: 'link',
              tabIndex: -1,
              'aria-label': `${span.s}.${called.s}`,
              onClick: (event) => {
                event.stopPropagation();
                if (hooks.external.lookup(span.s, called.s) === undefined) return;
                hooks.external.open(request);
              },
            }, [span.s, dot.s, called.s]));
            index += 2;
            previous = 'fn';
            continue;
          }
        }
        const member = previous !== null && previous.endsWith('.');
        const found = hooks === undefined || span.t !== 'fn' || member ? undefined : hooks.lookup(span.s);
        // A routine's own name on its declaration line is a definition, not a link.
        const target = found !== undefined && found.line !== number ? found : undefined;
        if (target !== undefined) {
          const reference = (event) => {
            // The click belongs to the reference, not to whatever wraps the code.
            event.stopPropagation();
            if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
            if (event.type === 'keydown') event.preventDefault();
            hooks.go(target);
          };
          children.push(h('span', {
            key: index,
            className: 'bslh-ref',
            style,
            'data-ref': target.line,
            role: 'link',
            tabIndex: -1,
            'aria-label': target.name,
            onClick: reference,
            onKeyDown: reference,
          }, span.s));
          previous = span.t;
          continue;
        }
        children.push(style === undefined ? span.s : h('span', { key: index, style }, span.s));
        // Whitespace never changes what the previous token was.
        if (span.t !== 'txt') previous = span.t === 'pun' ? span.s : span.t;
      }
      // `data-textpreview-line` is the owner's line anchor: it is what
      // `openFile(path, { line })` scrolls to, so a read row's path lands here.
      return h('div', {
        className: 'bslh-line',
        key: number,
        'data-bsl-line': number,
        'data-textpreview-line': number,
      }, [
        h('span', { className: 'bslh-gutter', key: 'n', 'aria-hidden': true }, String(number)),
        h('span', { className: 'bslh-text', key: 't' }, children),
      ]);
    }

    // ── «Процедуры и функции» ────────────────────────────────────────────────

    /** Declaration keyword (lowercase) to routine kind. */
    const ROUTINE_KINDS = new Map([
      ['процедура', 'procedure'],
      ['procedure', 'procedure'],
      ['функция', 'function'],
      ['function', 'function'],
    ]);

    /** Modifiers that may sit between the line start and the declaration keyword. */
    const ROUTINE_MODIFIERS = new Set(['асинх', 'async']);

    /** The marker that makes a routine part of the module interface. */
    const EXPORT_MARKERS = new Set(['экспорт', 'export']);

    /** Keys a modal dialog owns while it is open; they must not reach the app. */
    const DIALOG_KEYS = new Set(['Escape', 'Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']);

    /**
     * Collect the module's procedures and functions for the «Процедуры и функции»
     * list — the Configurator's own navigation dialog over a BSL module.
     *
     * It reads the already-tokenized lines, so it costs one linear pass over the
     * spans and never re-scans text. A declaration is a line whose first
     * significant token is `Процедура`/`Функция` (optionally behind `Асинх`) and
     * whose next name token follows; `Экспорт` anywhere on that line marks the
     * routine as exported. Anything unexpected is skipped rather than guessed.
     *
     * @param lines - token spans per source line, from {@link tokenizeBsl}.
     * @returns routines in source order, each with its 1-based line.
     */
    function collectSymbols(lines) {
      const symbols = [];
      for (let index = 0; index < lines.length; index += 1) {
        // Whitespace and newlines are the only `txt` spans, so this keeps the
        // significant tokens of the line in their source order.
        const tokens = lines[index].filter((span) => span.t !== 'txt');
        if (tokens.length === 0) continue;
        let at = 0;
        while (at < tokens.length && tokens[at].t === 'kw'
          && ROUTINE_MODIFIERS.has(tokens[at].s.toLowerCase())) at += 1;
        const head = tokens[at];
        if (head === undefined || head.t !== 'kw') continue;
        const kind = ROUTINE_KINDS.get(head.s.toLowerCase());
        if (kind === undefined) continue;

        let name;
        let exported = false;
        // The whole declaration line is scanned: `Экспорт` sits after the
        // parameter list, so the scan cannot stop at the opening parenthesis.
        for (let cursor = at + 1; cursor < tokens.length; cursor += 1) {
          const token = tokens[cursor];
          if (token.t === 'kw' && EXPORT_MARKERS.has(token.s.toLowerCase())) {
            exported = true;
            continue;
          }
          // The first identifier is the name; `Имя(` arrives as a call site.
          if (name === undefined) {
            if (token.t === 'id' || token.t === 'fn' || token.t === 'type') {
              name = token.s;
              continue;
            }
            if (token.t === 'pun') break;
          }
        }
        if (name === undefined) continue;
        symbols.push({ name, kind, line: index + 1, exported });
      }
      return symbols;
    }

    /** Keywords that close a routine body. */
    const ROUTINE_ENDS = new Set([
      'конецпроцедуры', 'конецфункции', 'endprocedure', 'endfunction',
    ]);

    /**
     * Build the module's call graph for the «Взаимосвязи» tree.
     *
     * Each routine gets the routines of this module it calls from its body, and
     * the inverse edges are folded into `callers`. Only *bare* calls count:
     * `ОбработатьСтрокуМакета(x)` is a call into this module, while
     * `Объект.Записать()` is a member call on another object and never becomes an
     * edge, even when a routine here happens to share the name. A routine that
     * calls itself keeps that edge, and the tree renderer marks the cycle.
     *
     * @param lines - token spans per source line, from {@link tokenizeBsl}.
     * @returns `symbols` with `endLine`/`calls`, plus the `callers` table.
     */
    function analyzeModule(lines) {
      const symbols = collectSymbols(lines);
      const byName = new Map();
      for (let index = 0; index < symbols.length; index += 1) {
        const key = symbols[index].name.toLowerCase();
        if (!byName.has(key)) byName.set(key, index);
      }

      for (let index = 0; index < symbols.length; index += 1) {
        const symbol = symbols[index];
        const start = symbol.line - 1;
        const limit = index + 1 < symbols.length ? symbols[index + 1].line - 1 : lines.length;
        // The last line of the routine: the closing keyword, or the line before the
        // next declaration. `endLine` is a 1-based line number, which doubles as
        // the exclusive end of a 0-based slice, so previews and frames agree.
        let lastIndex = limit - 1;
        for (let cursor = start + 1; cursor < limit; cursor += 1) {
          const head = lines[cursor].find((span) => span.t !== 'txt');
          if (head !== undefined && head.t === 'kw' && ROUTINE_ENDS.has(head.s.toLowerCase())) {
            lastIndex = cursor;
            break;
          }
        }
        const endLine = Math.max(symbol.line, lastIndex + 1);
        symbol.endLine = endLine;

        const calls = [];
        const seen = new Set();
        for (let cursor = start + 1; cursor < endLine; cursor += 1) {
          let previous = null;
          for (const span of lines[cursor]) {
            if (span.t === 'txt') continue;
            // A name right after a dot belongs to another object, not to us.
            const member = previous !== null && previous.endsWith('.');
            if (span.t === 'fn' && !member) {
              const target = byName.get(span.s.toLowerCase());
              if (target !== undefined && !seen.has(target)) {
                seen.add(target);
                calls.push(target);
              }
            }
            previous = span.t === 'pun' ? span.s : span.t;
          }
        }
        symbol.calls = calls;
      }

      const callers = symbols.map(() => []);
      symbols.forEach((symbol, index) => {
        for (const target of symbol.calls) callers[target].push(index);
      });

      return { symbols, callers };
    }

    /**
     * How many rows an auto-expanded tree may open before it stops unfolding.
     *
     * A diamond-shaped graph multiplies paths, and a tree that opens every one
     * of them would be slow to draw and useless to read; the cap keeps the first
     * levels open and leaves the rest to the reader.
     */
    const TREE_AUTO_EXPAND_LIMIT = 600;

    /**
     * Collect every row key that can be expanded, walking the same graph the
     * renderer walks — the set that opens a tree fully unfolded.
     *
     * @param symbols - routines from {@link analyzeModule}.
     * @param callers - inverse edges from {@link analyzeModule}.
     * @param mode - `calls` or `callers`.
     * @param limit - maximum keys to collect (see {@link TREE_AUTO_EXPAND_LIMIT}).
     * @returns the expandable keys, roots included.
     */
    function allTreeKeys(symbols, callers, mode, limit = TREE_AUTO_EXPAND_LIMIT) {
      const keys = new Set();
      const walk = (index, key, ancestors) => {
        if (keys.size >= limit) return;
        const children = mode === 'callers' ? callers[index] : symbols[index].calls;
        if (ancestors.has(index) || children.length === 0) return;
        keys.add(key);
        if (keys.size >= limit) return;
        const deeper = new Set(ancestors);
        deeper.add(index);
        for (const child of children) walk(child, `${key}>${child}`, deeper);
      };
      symbols.forEach((_symbol, index) => walk(index, String(index), new Set()));
      return keys;
    }

    /**
     * Flatten one direction of the call graph into the rows a tree view draws.
     *
     * Roots are every routine in source order, so the whole module is visible at
     * once; expanding a row appends its neighbours in the chosen direction. A row
     * whose routine already sits among its own ancestors is marked `cycle` and
     * gets no children, which is what keeps a recursive module finite.
     *
     * @param symbols - routines from {@link analyzeModule}.
     * @param callers - inverse edges from {@link analyzeModule}.
     * @param mode - `calls` (what this routine calls) or `callers` (who calls it).
     * @param expanded - keys of the rows the reader opened.
     * @returns rows in display order, each with its depth and parent row.
     */
    function buildTreeRows(symbols, callers, mode, expanded) {
      const rows = [];
      const walk = (index, depth, key, parent, ancestors) => {
        const symbol = symbols[index];
        const children = mode === 'callers' ? callers[index] : symbol.calls;
        const cycle = ancestors.has(index);
        const expandable = !cycle && children.length > 0;
        const open = expandable && expanded.has(key);
        const row = rows.length;
        rows.push({
          key,
          depth,
          index,
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          exported: symbol.exported,
          cycle,
          expandable,
          expanded: open,
          count: children.length,
          parent,
        });
        if (!open) return;
        const deeper = new Set(ancestors);
        deeper.add(index);
        for (const child of children) walk(child, depth + 1, `${key}>${child}`, row, deeper);
      };
      symbols.forEach((_symbol, index) => walk(index, 0, String(index), -1, new Set()));
      return rows;
    }

    /**
     * Whether a line carries nothing but a comment.
     *
     * The comment above a declaration documents that routine, so the frame takes it
     * in; a `#Область` header or code does not, and stops the walk.
     *
     * @param spans - the line's token spans.
     * @returns true for a comment-only line.
     */
    function commentOnlyLine(spans) {
      if (spans === undefined) return false;
      let seen = false;
      for (const span of spans) {
        if (span.t === 'txt') continue;
        if (span.t !== 'com') return false;
        seen = true;
      }
      return seen;
    }

    /**
     * Whether the name on the left of a dot can be a module of this configuration.
     *
     * A module call (`актив_Бюджетирование_ПоЗатратамНаВыпуск.ПрименитьОтбор`)
     * is what cfsmcp2 can resolve by name; an object method
     * (`Документ.Записать()`) cannot be resolved that way, and framing it would
     * promise something the bridge cannot deliver.
     *
     * Modules of this configuration carry an underscore; any name a lookup has
     * already confirmed is remembered for the rest of the session.
     *
     * @param name - the identifier before the dot.
     * @param known - lowercase names already resolved.
     * @returns whether the call may leave this module.
     */
    function looksLikeExternalModule(name, known) {
      if (name === '') return false;
      if (name.includes('_')) return true;
      return known !== undefined && known !== null && known.has(name.toLowerCase());
    }

    /**
     * The routine whose frame contains a source line.
     * @param symbols - routines from {@link analyzeModule}.
     * @param line - 1-based source line.
     * @returns the routine's declaration line, or 0 when the line is outside every frame.
     */
    function routineAt(symbols, line) {
      for (const symbol of symbols) {
        if (line >= symbol.line && line <= symbol.endLine) return symbol.line;
      }
      return 0;
    }

    /**
     * Cut the module into the blocks the code page draws: one framed block per
     * routine from the list, and plain runs for everything between them (regions,
     * module-level code, the tail after the last routine).
     *
     * Ranges come from the analysis, so a frame is exactly the routine the list
     * and the tree know: its declaration line through `КонецПроцедуры`
     * (`endLine` doubles as the exclusive end of a 0-based slice).
     *
     * @param lines - token spans per source line.
     * @param symbols - routines from {@link analyzeModule}.
     * @returns blocks in source order, each carrying its own span slice.
     */
    function segmentModule(lines, symbols) {
      const blocks = [];
      const ordered = [...symbols].sort((left, right) => left.line - right.line);
      let cursor = 0;
      for (const symbol of ordered) {
        let from = symbol.line - 1;
        // The comment block directly above the declaration belongs to the routine.
        while (from > cursor && commentOnlyLine(lines[from - 1])) from -= 1;
        const to = Math.min(Math.max(symbol.endLine, symbol.line), lines.length);
        if (from < cursor || to <= from) continue;
        if (from > cursor) {
          blocks.push({ kind: 'plain', from: cursor, to: from, spans: lines.slice(cursor, from) });
        }
        blocks.push({ kind: 'routine', symbol, from, to, spans: lines.slice(from, to) });
        cursor = to;
      }
      if (cursor < lines.length) {
        blocks.push({ kind: 'plain', from: cursor, to: lines.length, spans: lines.slice(cursor) });
      }
      return blocks;
    }

    /**
     * Order routines for display.
     * @param symbols - routines in source order.
     * @param byName - whether the «Сортировка» box is on.
     * @returns the routines to render (source order, or by name).
     */
    function sortedSymbols(symbols, byName) {
      if (!byName) return symbols;
      return [...symbols].sort((left, right) => left.name.localeCompare(right.name, 'ru', { sensitivity: 'base' }));
    }

    /**
     * Wrap a control in the app's tooltip when that primitive is available.
     * @param label - tooltip text.
     * @param child - the control.
     * @returns the control, wrapped or bare.
     */
    function withTooltip(label, child) {
      const Tooltip = primitives.Tooltip;
      if (typeof Tooltip !== 'function') return child;
      return h(Tooltip, { label, side: 'bottom', delayMs: 400 }, child);
    }

    /** The small list-with-magnifier glyph of the Configurator's toolbar button. */
    function symbolsGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 15,
        height: 15,
        'aria-hidden': true,
        focusable: 'false',
      }, [
        h('path', {
          key: 'rows',
          d: 'M2 3.5h8M2 6.5h8M2 9.5h5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('circle', {
          key: 'lens',
          cx: 10.4,
          cy: 9.4,
          r: 2.5,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
        }),
        h('path', {
          key: 'handle',
          d: 'M12.3 11.3l2 2',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      ]);
    }

    /**
     * The code of one routine, highlighted exactly like the page behind the
     * dialog: the same tokenizer output, palette and gutter, so a selected
     * routine reads the same on both sides of the dialog.
     *
     * @param props - the routine's slice, or null while nothing is selected.
     * @returns the preview pane.
     */
    function CodePreview({ preview, hooks, canBack, onBack, t }) {
      if (preview === null || preview === undefined) {
        return h('div', { className: 'bslh-pane-code' }, h('p', { className: 'bslh-status' }, t('previewEmpty')));
      }
      // The gutter is as wide as the file's last line, not the routine's, so the
      // numbers sit in the same column as on the page.
      const gutter = { '--bslh-gutter': `${String(preview.to).length}ch` };
      // Calls to the module's own routines are framed here exactly as on the page,
      // so the dialog can be walked the same way.
      const rows = preview.spans.map((spans, index) => renderLine(spans, preview.from + index, hooks));
      return h('div', { className: 'bslh-pane-code', style: gutter }, [
        h('div', { className: 'bslh-pane-caption', key: 'caption' }, [
          // Above the code, not in the title bar: the button acts on this pane.
          ...(onBack === undefined ? [] : [h(BackButton, { key: 'back', canBack, onClick: onBack, t })]),
          h('span', {
            key: 'badge',
            className: 'bslh-badge',
            'data-kind': preview.kind,
            'aria-hidden': true,
          }, preview.kind === 'procedure' ? 'P' : 'F'),
          h('span', { key: 'name', className: 'bslh-preview-name' }, preview.name),
          h('span', { key: 'range', className: 'bslh-preview-range' }, t('linesRange', { from: preview.from, to: preview.to })),
        ]),
        h('div', { className: 'bslh-pane-scroll', key: 'scroll' },
          h('pre', { className: 'bslh-pre bslh-pre-pane' }, h('code', null, rows))),
      ]);
    }

    /**
     * The three footer actions both dialogs share.
     * @param props - the dialog's verbs and whether a row is selected.
     * @returns the buttons, in tab order.
     */
    function dialogButtons({ help, disabled, onGo, onCancel, onToggleHelp, t }) {
      return [
        h('button', {
          key: 'go',
          type: 'button',
          className: 'bslh-button',
          'data-primary': 'true',
          disabled,
          onClick: onGo,
        }, t('go')),
        h('button', {
          key: 'cancel',
          type: 'button',
          className: 'bslh-button',
          onClick: onCancel,
        }, t('cancel')),
        h('button', {
          key: 'help',
          type: 'button',
          className: 'bslh-button',
          'aria-expanded': help ? 'true' : 'false',
          onClick: onToggleHelp,
        }, t('help')),
      ];
    }

    /**
     * The «Процедуры и функции» dialog: the module's routines on the left, the
     * selected routine's highlighted source on the right.
     *
     * Stateless on purpose — the owner owns selection, sorting, the preview slice
     * and the help toggle — so the list can be exercised without mounting the
     * whole pane.
     *
     * @param props - routines, selection, preview, and the dialog's verbs.
     * @returns the dialog (or nothing when closed).
     */
    /** The back arrow: return the keyboard and the code to where the click came from. */
    function backGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 15,
        height: 15,
        'aria-hidden': true,
        focusable: 'false',
      }, [
        h('path', {
          key: 'shaft',
          d: 'M13 8H3.6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'head',
          d: 'M7.4 3.8 3.2 8l4.2 4.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ]);
    }

    /** The call-tree glyph: a spine with three branches. */
    function treeGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 15,
        height: 15,
        'aria-hidden': true,
        focusable: 'false',
      }, [
        h('path', {
          key: 'spine',
          d: 'M3.5 3v10',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'branches',
          d: 'M3.5 4h4M3.5 8h4M3.5 12h4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('circle', { key: 'a', cx: 10, cy: 4, r: 1.6, fill: 'currentColor' }),
        h('circle', { key: 'b', cx: 10, cy: 8, r: 1.6, fill: 'currentColor' }),
        h('circle', { key: 'c', cx: 10, cy: 12, r: 1.6, fill: 'currentColor' }),
      ]);
    }

    /**
     * The «Назад» control shared by the page and the dialog: a corner button with
     * an arrow and a label, so it reads as an action and not as decoration.
     *
     * @param props - whether there is a place to return to, and the handler.
     * @returns the button.
     */
    function BackButton({ canBack, onClick, t }) {
      return h('button', {
        type: 'button',
        className: 'bslh-back',
        'data-bsl-back': true,
        'aria-label': t('back'),
        disabled: !canBack,
        onClick,
      }, [
        h('span', { className: 'bslh-back-icon', key: 'icon' }, backGlyph()),
        h('span', { key: 'label' }, t('back')),
      ]);
    }

    /**
     * The call tree: one row per routine, indented by depth, with a twisty button,
     * the kind badge, the absolute source line, a cycle mark and the number of
     * routines hidden inside a collapsed branch.
     *
     * The depth guides are the row's own background: a repeating gradient whose
     * size is `--bslh-depth`, so nesting reads without extra elements.
     */
    function TreeView({ rows, activeIndex, onActivate, onToggleRow, onGo, t }) {
      return h('ul', {
        className: 'bslh-tree',
        role: 'tree',
        tabIndex: -1,
        'data-focus-anchor': true,
        'aria-activedescendant': rows[activeIndex] === undefined ? undefined : `bslh-tree-${rows[activeIndex].key}`,
      }, rows.map((row, index) => {
        const cells = [
          h('button', {
            key: 'twisty',
            type: 'button',
            className: 'bslh-twisty',
            tabIndex: -1,
            'data-empty': row.expandable ? 'false' : 'true',
            'aria-label': row.expandable ? (row.expanded ? t('collapse') : t('expand')) : t('expand'),
            onClick: (event) => {
              event.stopPropagation();
              if (row.expandable) onToggleRow(row.key);
            },
          }, row.expandable ? (row.expanded ? '▾' : '▸') : '·'),
          h('span', {
            key: 'badge',
            className: 'bslh-badge',
            'data-kind': row.kind,
            'aria-hidden': true,
          }, row.kind === 'procedure' ? 'P' : 'F'),
          h('span', { key: 'name', className: 'bslh-symbol-name' }, row.name),
        ];
        if (row.cycle) cells.push(h('span', { key: 'cycle', className: 'bslh-cycle' }, '↻'));
        if (row.expandable && !row.expanded && row.count > 0) {
          cells.push(h('span', { key: 'count', className: 'bslh-tree-count' }, `(${row.count})`));
        }
        cells.push(h('span', { key: 'line', className: 'bslh-symbol-line' }, String(row.line)));
        return h('li', {
          key: row.key,
          id: `bslh-tree-${row.key}`,
          className: 'bslh-tree-row',
          role: 'treeitem',
          'data-depth': row.depth,
          'data-active': index === activeIndex ? 'true' : 'false',
          'aria-selected': index === activeIndex ? 'true' : 'false',
          'aria-expanded': row.expandable ? (row.expanded ? 'true' : 'false') : undefined,
          'aria-level': row.depth + 1,
          // 16px per level matches the guide gradient's spacing.
          style: { paddingLeft: `${8 + row.depth * 16}px`, '--bslh-depth': row.depth },
          onClick: () => onActivate(index),
          onDoubleClick: () => onGo(),
        }, cells);
      }));
    }

    /**
     * The source of a routine that lives in another module.
     *
     * It is read through cfsmcp2 on the host side (the page cannot call the MCP
     * server itself) and painted with the same palette as the open file, so a
     * cross-module reference costs no context switch.
     */
    function ExternalDialog({ request, phase, entry, error, onClose, t }) {
      const preview = React.useMemo(() => {
        if (entry === null || entry === undefined || typeof entry.source !== 'string') return null;
        const spans = tokenizeBsl(entry.source);
        const from = Number.isInteger(entry.line) && entry.line > 0 ? entry.line : 1;
        return {
          name: `${entry.module}.${entry.method}`,
          kind: entry.kind === 'function' ? 'function' : 'procedure',
          from,
          to: from + Math.max(0, spans.length - 1),
          spans,
        };
      }, [entry]);

      const onKeyDown = (event) => {
        if (event.key !== 'Escape' && event.key !== 'Tab') return;
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
          return;
        }
        const items = [...event.currentTarget.querySelectorAll('button:not([disabled])')];
        if (items.length === 0) return;
        const firstItem = items[0];
        const lastItem = items[items.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === firstItem || active === event.currentTarget)) {
          event.preventDefault();
          lastItem.focus();
        } else if (!event.shiftKey && active === lastItem) {
          event.preventDefault();
          firstItem.focus();
        }
      };

      return h('div', {
        className: 'bslh-modal',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
      }, h('div', {
        className: 'bslh-dialog bslh-dialog-wide',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': `${request.module}.${request.method}`,
        onKeyDown,
      }, [
        h('div', { className: 'bslh-dialog-head', key: 'head' }, [
          h('div', { className: 'bslh-dialog-head-left', key: 'left' }, [
            h('span', { className: 'bslh-dialog-title', key: 'title' }, t('external')),
            h('span', { className: 'bslh-ext-name', key: 'name' }, `${request.module}.${request.method}`),
          ]),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'bslh-dialog-close',
            'aria-label': t('cancel'),
            onClick: onClose,
          }, '×'),
        ]),
        h('div', { className: 'bslh-dialog-main', key: 'main' }, [
          preview === null
            ? h('div', { className: 'bslh-pane-code', key: 'status' }, h('p', {
              className: 'bslh-status',
              'data-external-phase': phase,
            }, phase === 'loading' ? t('externalLoading') : (error ?? t('externalEmpty'))))
            : h(CodePreview, { key: `ext:${preview.from}`, preview, t }),
        ]),
        h('div', { className: 'bslh-dialog-foot', key: 'foot' }, [
          h('span', { key: 'source', className: 'bslh-foot-note' }, entry !== null && entry !== undefined && typeof entry.context === 'string'
            ? `${t('externalSource')} · ${entry.context}`
            : t('externalSource')),
          h('span', { key: 'spacer', className: 'bslh-foot-spacer' }),
          h('button', { key: 'close', type: 'button', className: 'bslh-button', onClick: onClose }, t('close')),
        ]),
      ]));
    }

    /**
     * The flat list of routines: the «Список» tab's left pane.
     *
     * It is a listbox with a moving active row, so the pane keeps a single tab stop
     * and the arrow keys walk the rows.
     */
    function SymbolsList({ symbols, activeIndex, onActivate, onGo, t }) {
      const rows = symbols.map((symbol, index) => {
        const cells = [
          h('span', {
            key: 'badge',
            className: 'bslh-badge',
            'data-kind': symbol.kind,
            'aria-hidden': true,
          }, symbol.kind === 'procedure' ? 'P' : 'F'),
          h('span', { key: 'name', className: 'bslh-symbol-name' }, symbol.name),
        ];
        if (symbol.exported) cells.push(h('span', { key: 'export', className: 'bslh-symbol-export' }, t('exported')));
        cells.push(h('span', { key: 'line', className: 'bslh-symbol-line' }, String(symbol.line)));
        return h('li', {
          key: `${symbol.line}:${symbol.name}`,
          id: `bslh-symbol-${index}`,
          className: 'bslh-symbol',
          role: 'option',
          'aria-selected': index === activeIndex ? 'true' : 'false',
          'data-active': index === activeIndex ? 'true' : 'false',
          'data-symbol-index': index,
          onClick: () => onActivate(index),
          onDoubleClick: () => onGo(index),
        }, cells);
      });

      return h('ul', {
        className: 'bslh-symbols',
        role: 'listbox',
        tabIndex: -1,
        'data-focus-anchor': true,
        'aria-activedescendant': `bslh-symbol-${activeIndex}`,
      }, rows);
    }

    /**
     * The one navigation dialog.
     *
     * The tabs switch what the left pane shows — the flat list, the routines this
     * one calls, the routines that call it — while the code on the right and the
     * footer buttons stay where they are. «Назад» sits above the code, because it
     * returns the code pane, not the picker.
     */
    function NavDialog({
      tabs, tab, onTab, pane, preview, hooks, canBack, onBack, sorted, onToggleSort,
      help, helpText, goDisabled, onGo, onCancel, onToggleHelp, onMove, onHorizontal, t,
    }) {
      const paneRef = React.useRef(null);
      // The pane takes focus on open and on every tab switch, so the arrow keys
      // act on the picker at once instead of on the page behind it.
      React.useEffect(() => {
        const host = paneRef.current;
        if (host === null || host === undefined) return;
        const anchor = typeof host.querySelector === 'function' ? host.querySelector('[data-focus-anchor]') : null;
        const target = anchor === null || anchor === undefined ? host : anchor;
        if (target !== null && target !== undefined && typeof target.focus === 'function') target.focus();
      }, [tab]);

      const onKeyDown = (event) => {
        const { key } = event;
        const horizontal = key === 'ArrowRight' || key === 'ArrowLeft';
        if (!DIALOG_KEYS.has(key) && !horizontal) return;
        // The app listens for Escape and arrows on the document; an open dialog
        // owns them, otherwise closing it would also act on the pane behind.
        event.stopPropagation();
        if (key === 'Escape') {
          event.preventDefault();
          onCancel();
          return;
        }
        if (key === 'Enter') {
          event.preventDefault();
          onGo();
          return;
        }
        if (key === 'Tab') {
          // Focus stays in the dialog: `aria-modal` promises it, so the tab ring
          // must not walk into the dimmed application behind.
          const items = [...event.currentTarget.querySelectorAll('button:not([disabled]), input:not([disabled])')];
          if (items.length === 0) return;
          const firstItem = items[0];
          const lastItem = items[items.length - 1];
          const active = document.activeElement;
          if (event.shiftKey && (active === firstItem || active === event.currentTarget)) {
            event.preventDefault();
            lastItem.focus();
          } else if (!event.shiftKey && active === lastItem) {
            event.preventDefault();
            firstItem.focus();
          }
          return;
        }
        if (horizontal) {
          if (onHorizontal === undefined) return;
          event.preventDefault();
          onHorizontal(key);
          return;
        }
        event.preventDefault();
        onMove(key);
      };

      return h('div', {
        className: 'bslh-modal',
        // The backdrop closes, the card does not; a click inside must stop here.
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onCancel();
        },
      }, h('div', {
        className: 'bslh-dialog bslh-dialog-wide',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('nav'),
        onKeyDown,
      }, [
        h('div', { className: 'bslh-dialog-head', key: 'head' }, [
          h('div', {
            className: 'bslh-tabs',
            key: 'tabs',
            role: 'tablist',
            'aria-label': t('nav'),
          }, tabs.map((entry) => h('button', {
            key: entry.key,
            type: 'button',
            className: 'bslh-tab',
            role: 'tab',
            'data-tab': entry.key,
            'data-active': tab === entry.key ? 'true' : 'false',
            'aria-selected': tab === entry.key ? 'true' : 'false',
            onClick: () => onTab(entry.key),
          }, entry.label))),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'bslh-dialog-close',
            'aria-label': t('cancel'),
            onClick: onCancel,
          }, '×'),
        ]),
        h('div', { className: 'bslh-dialog-main', key: 'main' }, [
          h('div', { className: 'bslh-pane-left', key: 'left', ref: paneRef, tabIndex: -1 }, pane),
          // The pane remounts per routine, so its scrollbar starts at the top again.
          h(CodePreview, { key: `code:${preview === null || preview === undefined ? 'none' : preview.from}`, preview, hooks, canBack, onBack, t }),
        ]),
        h('div', { className: 'bslh-dialog-foot', key: 'foot' }, [
          // The sort box belongs to the flat list; the trees have no order to pick.
          ...(onToggleSort === undefined ? [] : [h('label', { key: 'sort', className: 'bslh-sort' }, [
            h('input', {
              key: 'box',
              type: 'checkbox',
              checked: sorted === true,
              onChange: onToggleSort,
            }),
            h('span', { key: 'label' }, t('sortByName')),
          ])]),
          h('span', { key: 'spacer', className: 'bslh-foot-spacer' }),
          ...dialogButtons({
            help,
            disabled: goDisabled === true,
            onGo,
            onCancel,
            onToggleHelp,
            t,
          }),
        ]),
        help ? h('div', { className: 'bslh-help', key: 'help' }, helpText) : null,
      ]));
    }

    /**
     * The document preview body for a 1C module.
     *
     * Receives the preview owner's standard props: the accumulated text, the
     * wrap preference, and the callback ref that registers this element as the
     * pane's scroll owner (the owner restores the offset and pages the next
     * chunk when it is scrolled to the end).
     *
     * @param props - document preview body props.
     * @returns the line-numbered, highlighted source view.
     */
    function BslBody({ content, wrap, scrollportRef, t }) {
      const text = content !== undefined && content !== null && content.kind === 'text' ? content.text : '';
      const lines = React.useMemo(() => tokenizeBsl(text), [text]);
      const analysis = React.useMemo(() => analyzeModule(lines), [lines]);
      const symbols = analysis.symbols;
      const [copied, setCopied] = React.useState(false);
      // One navigation dialog: «Список» / «Вызывает» / «Вызывают» are its tabs.
      const [navOpen, setNavOpen] = React.useState(false);
      const [navTab, setNavTab] = React.useState('calls');
      const [activeIndex, setActiveIndex] = React.useState(0);
      const [byName, setByName] = React.useState(false);
      const [help, setHelp] = React.useState(false);
      // The tree dialog owns its own mode, open rows and selection.
      const [treeExpanded, setTreeExpanded] = React.useState(() => new Set());
      const [treeActive, setTreeActive] = React.useState(0);
      // Navigation inside the page: the routine the reader entered, and the trail
      // of places to come back to (bounded, so a long session cannot grow forever).
      const [currentRoutine, setCurrentRoutine] = React.useState(0);
      const [trail, setTrail] = React.useState([]);
      // Inside a dialog, following a reference peeks at another routine without
      // moving the picker; its own «Назад» unwinds that peek.
      // The left picker and the preview show the same routine, so following a
      // reference moves the cursor there; the trail keeps the tab and the selection
      // to come back to.
      const [navTrail, setNavTrail] = React.useState([]);
      // A cross-module reference: the routine read through cfsmcp2, and the modules
      // a successful read has confirmed.
      const [external, setExternal] = React.useState(null);
      const [knownModules, setKnownModules] = React.useState(() => new Set());
      const timer = React.useRef(null);
      const targetTimer = React.useRef(null);
      const targetRow = React.useRef(null);
      // The dialog returns focus to the toolbar button that opened it.
      const navTrigger = React.useRef(null);
      const opener = React.useRef(null);
      // …and a click on a cross-module reference returns focus to that reference.
      const externalOpener = React.useRef(null);

      // One element, two owners: the pane binds it as its scrollport (offset
      // restore, paging), and the jump needs to read and move it directly.
      const scroller = React.useRef(null);
      const attachScrollport = React.useCallback((node) => {
        scroller.current = node;
        if (typeof scrollportRef === 'function') scrollportRef(node);
        else if (scrollportRef !== null && typeof scrollportRef === 'object') scrollportRef.current = node;
      }, [scrollportRef]);

      const onCopy = React.useCallback(() => {
        if (copied) return;
        copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            setCopied(false);
            timer.current = null;
          }, 1200);
        });
      }, [copied, text]);

      React.useEffect(() => () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        if (targetTimer.current !== null) window.clearTimeout(targetTimer.current);
      }, []);

      /** Scroll to a source line and mark it for a moment, the way the Configurator jumps. */
      const reveal = React.useCallback((line) => {
        const node = scroller.current;
        if (node === null) return;
        const row = node.querySelector(`[data-textpreview-line="${line}"]`);
        if (row === null) return;
        const offset = row.getBoundingClientRect().top - node.getBoundingClientRect().top;
        node.scrollTop = Math.max(0, node.scrollTop + offset - 8);
        // Marking through the DOM, not React state: a jump must not re-render
        // every line of a 5000-line module twice.
        if (targetRow.current !== null) targetRow.current.removeAttribute('data-target');
        row.setAttribute('data-target', 'true');
        targetRow.current = row;
        if (targetTimer.current !== null) window.clearTimeout(targetTimer.current);
        targetTimer.current = window.setTimeout(() => {
          row.removeAttribute('data-target');
          if (targetRow.current === row) targetRow.current = null;
          targetTimer.current = null;
        }, 2200);
      }, []);

      const visible = React.useMemo(() => sortedSymbols(symbols, byName), [symbols, byName]);

      /**
       * The highlighted source of one routine, for the dialogs' right pane.
       *
       * It slices the tokenized lines, so opening the preview costs no second
       * scan: the same spans the page draws are drawn again, with the file's own
       * line numbers.
       *
       * @param symbol - the routine to show, or undefined for none.
       * @returns the preview slice, or null.
       */
      const previewOf = React.useCallback((symbol) => {
        if (symbol === undefined || symbol === null) return null;
        // `endLine` comes from the analysis; a bare declaration entry (a caller
        // that only knows the start) previews its own line instead of spilling to
        // the end of the file.
        const to = Number.isInteger(symbol.endLine) && symbol.endLine >= symbol.line ? symbol.endLine : symbol.line;
        return {
          name: symbol.name,
          kind: symbol.kind,
          from: symbol.line,
          to,
          spans: lines.slice(symbol.line - 1, to),
        };
      }, [lines]);

      /**
       * The source line at the top of the viewport — where the reader is now.
       * @returns the 1-based line, or 1 when the pane is not measurable.
       */
      const topLine = React.useCallback(() => {
        const node = scroller.current;
        if (node === null) return 1;
        const viewportTop = node.getBoundingClientRect().top;
        const rows = node.querySelectorAll('[data-textpreview-line]');
        for (const row of rows) {
          if (row.getBoundingClientRect().top >= viewportTop - 1) {
            return Number(row.getAttribute('data-textpreview-line'));
          }
        }
        return 1;
      }, []);

      /** Remember what had focus before a dialog opened. */
      const rememberOpener = React.useCallback(() => {
        opener.current = typeof document === 'undefined' ? null : document.activeElement;
      }, []);

      /**
       * Close the list and give the keyboard back to the button that opened it.
       *
       * Every close — `Esc`, `×`, «Отмена», «Перейти» — goes through here, because
       * a dialog that unmounts with focus inside leaves focus on `document.body`
       * and the next Tab restarts from the top of the window.
       */
      const closeNav = React.useCallback(() => {
        setNavOpen(false);
        // A dialog that unmounts with focus inside leaves focus on `document.body`;
        // the corner button takes it back.
        focusElement(navTrigger.current ?? opener.current);
      }, []);

      /** Index in `symbols` of the routine the reader is inside. */
      const readerIndex = React.useCallback(() => {
        if (symbols.length === 0) return 0;
        const line = topLine();
        const here = [...symbols].filter((symbol) => symbol.line <= line).at(-1) ?? symbols[0];
        return symbols.findIndex((symbol) => symbol.line === here.line && symbol.name === here.name);
      }, [symbols, topLine]);

      const treeRows = React.useMemo(
        () => (navOpen && navTab !== 'list' ? buildTreeRows(symbols, analysis.callers, navTab, treeExpanded) : []),
        [analysis.callers, navOpen, navTab, symbols, treeExpanded],
      );
      const treePosition = Math.min(treeActive, Math.max(0, treeRows.length - 1));

      /**
       * Show one routine in the tree tab: unfold the whole tree, then put the
       * cursor on that routine's own root row.
       * @param mode - 'calls' or 'callers'.
       * @param subject - index in `symbols` to select, or -1 to keep the first row.
       */
      const showTree = React.useCallback((mode, subject) => {
        const expanded = allTreeKeys(symbols, analysis.callers, mode);
        const rows = buildTreeRows(symbols, analysis.callers, mode, expanded);
        const position = subject < 0 ? -1 : rows.findIndex((row) => row.depth === 0 && row.index === subject);
        setTreeExpanded(expanded);
        setTreeActive(position >= 0 ? position : 0);
      }, [analysis.callers, symbols]);

      const openNav = React.useCallback(() => {
        rememberOpener();
        setHelp(false);
        setNavTrail([]);
        // The form opens on «Вызывает» — the primary direction — and always on it,
        // so the first thing a reader sees does not depend on the last visit.
        setNavTab('calls');
        showTree('calls', readerIndex());
        setNavOpen(true);
      }, [readerIndex, rememberOpener, showTree]);

      /** The routine the active tab points at. */
      const navSymbol = React.useCallback(() => {
        if (navTab === 'list') return visible[activeIndex];
        const row = treeRows[treePosition];
        return row === undefined ? undefined : symbols[row.index];
      }, [activeIndex, navTab, symbols, treePosition, treeRows, visible]);

      /**
       * Switch tabs without losing the subject: whatever routine is in view stays
       * in view, selected in the new pane.
       * @param tab - 'list', 'calls' or 'callers'.
       */
      const switchTab = React.useCallback((tab) => {
        if (tab === navTab) return;
        const subject = symbols.indexOf(navSymbol() ?? {});
        setNavTrail([]);
        setNavTab(tab);
        if (tab === 'list') {
          const index = visible.indexOf(symbols[subject]);
          setActiveIndex(index >= 0 ? index : 0);
        } else {
          showTree(tab, subject);
        }
      }, [navSymbol, navTab, showTree, symbols, visible]);

      const moveNav = React.useCallback((key) => {
        const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[key];
        if (navTab === 'list') {
          setActiveIndex((current) => {
            const last = Math.max(0, visible.length - 1);
            if (key === 'Home') return 0;
            if (key === 'End') return last;
            return Math.min(Math.max(0, current + (step ?? 0)), last);
          });
          return;
        }
        setTreeActive((current) => {
          const last = Math.max(0, treeRows.length - 1);
          if (key === 'Home') return 0;
          if (key === 'End') return last;
          return Math.min(Math.max(0, current + (step ?? 0)), last);
        });
      }, [navTab, treeRows.length, visible.length]);

      const toggleRow = React.useCallback((key) => {
        setTreeExpanded((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }, []);

      /** ←/→ only mean something in the tree: collapse, expand, or walk to the parent. */
      const horizontalNav = React.useCallback((key) => {
        if (navTab === 'list') return;
        const node = treeRows[treePosition];
        if (node === undefined) return;
        if (key === 'ArrowRight') {
          if (node.expandable && !node.expanded) toggleRow(node.key);
          else if (node.expanded) {
            const child = treeRows[treePosition + 1];
            if (child !== undefined && child.depth > node.depth) setTreeActive(treePosition + 1);
          }
          return;
        }
        if (node.expanded) toggleRow(node.key);
        else if (node.parent >= 0) setTreeActive(node.parent);
      }, [navTab, toggleRow, treePosition, treeRows]);

      const goNav = React.useCallback(() => {
        const symbol = navSymbol();
        closeNav();
        if (symbol !== undefined) reveal(symbol.line);
      }, [closeNav, navSymbol, reveal]);

      const blocks = React.useMemo(() => segmentModule(lines, symbols), [lines, symbols]);

      /** Lowercase routine name to its declaration, for inline references. */
      const references = React.useMemo(() => {
        const map = new Map();
        for (const symbol of symbols) {
          const key = symbol.name.toLowerCase();
          if (!map.has(key)) map.set(key, symbol);
        }
        return map;
      }, [symbols]);

      /**
       * Click inside a routine's frame: jump to its declaration and remember where
       * the click came from, so «Назад» can bring the reader back.
       *
       * A drag that selected text is not a navigation — the reader was copying.
       */
      const enterRoutine = React.useCallback((symbol) => {
        if (symbol.line === currentRoutine) return;
        const selection = typeof window !== 'undefined' && typeof window.getSelection === 'function'
          ? window.getSelection()
          : null;
        if (selection !== null && !selection.isCollapsed) return;
        const node = scroller.current;
        const line = topLine();
        setTrail((stack) => [...stack.slice(-49), { routine: routineAt(symbols, line), scrollTop: node === null ? 0 : node.scrollTop }]);
        setCurrentRoutine(symbol.line);
        reveal(symbol.line);
      }, [currentRoutine, reveal, symbols, topLine]);

      /** Return to the place the last jump started from. */
      const goBack = React.useCallback(() => {
        if (trail.length === 0) return;
        const previous = trail[trail.length - 1];
        setTrail(trail.slice(0, -1));
        setCurrentRoutine(previous.routine);
        const node = scroller.current;
        if (node !== null) node.scrollTop = previous.scrollTop;
      }, [trail]);

      /**
       * Read a routine from another module through the host bridge.
       *
       * The page cannot reach cfsmcp2 (other port, no CORS): the host half proxies
       * one authenticated same-origin route. A successful read also teaches the
       * page that this name is a module, so its other calls get framed too.
       *
       * @param request - `{ module, method }` of the reference that was clicked.
       */
      const openExternal = React.useCallback((request) => {
        const active = typeof document === 'undefined' ? null : document.activeElement;
        externalOpener.current = active === null || active === undefined ? null : active;
        setExternal({ request, phase: 'loading', entry: null, error: null });
        // No context: the row's configuration decides which dump to read.
        const query = new URLSearchParams({ module: request.module, method: request.method });
        fetch(`/api/bsl-external/method?${query.toString()}`, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
          .then(async (response) => {
            // Anything but our own JSON means the host half is not mounted
            // (an unauthenticated `/api` answer is plain text).
            const text = await response.text();
            let body = null;
            try {
              body = JSON.parse(text);
            } catch {
              body = null;
            }
            return { status: response.status, body };
          })
          .then(({ status, body }) => {
            if (body !== null && typeof body === 'object' && body.found === true) {
              setKnownModules((previous) => {
                const key = request.module.toLowerCase();
                if (previous.has(key)) return previous;
                const next = new Set(previous);
                next.add(key);
                return next;
              });
              setExternal({ request, phase: 'ready', entry: body, error: null });
              return;
            }
            const reason = body !== null && typeof body === 'object' && typeof body.reason === 'string'
              ? body.reason
              : `${t('externalNoBridge')} (HTTP ${status})`;
            setExternal({ request, phase: 'error', entry: null, error: reason });
          })
          .catch((error) => {
            setExternal({ request, phase: 'error', entry: null, error: String(error?.message ?? error) });
          });
      }, [t]);

      /** Close the cross-module viewer and give the keyboard back to the reference. */
      const closeExternal = React.useCallback(() => {
        setExternal(null);
        focusElement(externalOpener.current);
      }, []);

      /** How the page renders a reference: resolve the name, jump to its routine. */
      /** Cross-module references: the page and both panes of the dialog share them. */
      const externalHooks = React.useMemo(() => ({
        lookup: (module, method) => (method === '' || !looksLikeExternalModule(module, knownModules)
          ? undefined
          : { module, method }),
        open: openExternal,
      }), [knownModules, openExternal]);

      const referenceHooks = React.useMemo(() => ({
        lookup: (name) => references.get(name.toLowerCase()),
        go: (symbol) => enterRoutine(symbol),
        external: externalHooks,
      }), [enterRoutine, externalHooks, references]);

      /** What the right pane shows: the routine the active tab points at. */
      const navPreview = React.useMemo(() => {
        if (navTab === 'list') return previewOf(visible[activeIndex]);
        const row = treeRows[treePosition];
        return row === undefined ? null : previewOf(symbols[row.index]);
      }, [activeIndex, navTab, previewOf, symbols, treePosition, treeRows, visible]);

      /**
       * Follow a reference from the code pane: the picker moves onto that routine,
       * so the cursor on the left and the code on the right never disagree.
       * @param symbol - the routine the reference points at.
       */
      const followRef = React.useCallback((symbol) => {
        const target = symbols.indexOf(symbol);
        if (target < 0) return;
        const here = navSymbol();
        if (here !== undefined && here.line === symbol.line) return;
        setNavTrail((stack) => [...stack.slice(-19), { tab: navTab, activeIndex, treeActive }]);
        if (navTab === 'list') {
          const index = visible.indexOf(symbol);
          if (index >= 0) setActiveIndex(index);
          return;
        }
        // Every routine is a root row, so a reference always has a row to land on.
        let row = treeRows.findIndex((entry) => entry.depth === 0 && entry.index === target);
        if (row < 0) row = treeRows.findIndex((entry) => entry.index === target);
        if (row >= 0) setTreeActive(row);
      }, [activeIndex, navSymbol, navTab, symbols, treeActive, treeRows, visible]);

      const navBack = React.useCallback(() => {
        if (navTrail.length === 0) return;
        const previous = navTrail[navTrail.length - 1];
        setNavTrail(navTrail.slice(0, -1));
        setNavTab(previous.tab);
        setActiveIndex(previous.activeIndex);
        setTreeActive(previous.treeActive);
      }, [navTrail]);

      const navRefHooks = React.useMemo(
        () => ({ lookup: referenceHooks.lookup, go: followRef, external: externalHooks }),
        [externalHooks, followRef, referenceHooks.lookup],
      );

      // The two call directions lead; the flat list is the last tab.
      const navTabs = React.useMemo(() => [
        { key: 'calls', label: t('modeCalls') },
        { key: 'callers', label: t('modeCallers') },
        { key: 'list', label: t('tabList') },
      ], [t]);

      const navDialog = navOpen ? h(NavDialog, {
        key: 'nav',
        tabs: navTabs,
        tab: navTab,
        onTab: switchTab,
        pane: navTab === 'list'
          ? (visible.length === 0
            ? h('p', { className: 'bslh-status', key: 'empty' }, t('symbolsEmpty'))
            : h(SymbolsList, { key: 'list', symbols: visible, activeIndex, onActivate: setActiveIndex, onGo: goNav, t }))
          : (treeRows.length === 0
            ? h('p', { className: 'bslh-status', key: 'empty' }, t('symbolsEmpty'))
            : h(TreeView, {
              key: 'tree',
              rows: treeRows,
              activeIndex: treePosition,
              onActivate: setTreeActive,
              onToggleRow: toggleRow,
              onGo: goNav,
              t,
            })),
        preview: navPreview,
        hooks: navRefHooks,
        canBack: navTrail.length > 0,
        onBack: navBack,
        sorted: byName,
        onToggleSort: navTab === 'list' ? () => setByName(!byName) : undefined,
        help,
        helpText: navTab === 'list' ? t('helpText') : t('treeHelpText'),
        goDisabled: navTab === 'list' ? visible.length === 0 : treeRows.length === 0,
        onGo: goNav,
        onCancel: closeNav,
        onToggleHelp: () => setHelp(!help),
        onMove: moveNav,
        onHorizontal: navTab === 'list' ? undefined : horizontalNav,
        t,
      }) : null;

      const externalDialog = external === null ? null : h(ExternalDialog, {
        key: 'external',
        request: external.request,
        phase: external.phase,
        entry: external.entry,
        error: external.error,
        onClose: closeExternal,
        t,
      });

      const portal = typeof reactDom === 'object' && reactDom !== null && typeof reactDom.createPortal === 'function'
        ? reactDom.createPortal([navDialog, externalDialog], document.body)
        : [navDialog, externalDialog];

      // Escape is captured on the window while a dialog is open, so it closes even
      // if focus was moved by a pointer click somewhere outside the card.
      React.useEffect(() => {
        if (!navOpen && external === null) return undefined;
        // A rendering host without a browser window (server render, tests) has no
        // event target; the dialog still closes through its own handler.
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          // The cross-module viewer sits on top, so it closes first.
          if (external !== null) closeExternal();
          else closeNav();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [closeExternal, closeNav, external, navOpen]);

      const digits = String(lines.length).length;
      const style = { '--bslh-gutter': `${digits}ch` };

      return h('div', {
        className: 'bslh-root',
        // The pane's layout rule keys on this attribute: it turns the shared
        // body wrapper into the flex column this inner scrollport needs, the
        // same contract the built-in code preview uses.
        'data-code-preview': true,
        'data-bsl-preview': true,
        'data-wrap': wrap ? 'true' : 'false',
        style,
      }, [
        h('div', { className: 'bslh-bar', key: 'bar' }, [
          h('div', { className: 'bslh-heading', key: 'heading' }, [
            text === '' ? null : h(BackButton, {
              key: 'back',
              canBack: trail.length > 0,
              onClick: goBack,
              t,
            }),
            text === '' ? null : withTooltip(t('navCount', { count: symbols.length }), h('button', {
              type: 'button',
              className: 'bslh-navbtn',
              key: 'nav',
              ref: navTrigger,
              'data-bsl-nav': true,
              'aria-label': t('navCount', { count: symbols.length }),
              'aria-haspopup': 'dialog',
              'aria-expanded': navOpen ? 'true' : 'false',
              onClick: openNav,
            }, treeGlyph())),
            h('span', { className: 'bslh-lang', key: 'lang' }, t('language')),
            h('span', { className: 'bslh-meta', key: 'meta' }, text === '' ? '' : t('lines', { count: lines.length })),
          ]),
          h('div', { className: 'bslh-actions', key: 'actions' }, [
            text === '' ? null : h('button', {
              type: 'button',
              className: 'bslh-copy',
              key: 'copy',
              onClick: onCopy,
              children: copied ? t('copied') : t('copy'),
            }),
          ]),
        ]),
        h('div', { className: 'bslh-scroll', key: 'scroll', ref: attachScrollport }, text === ''
          ? h('p', { className: 'bslh-empty' }, t('empty'))
          : h('pre', { className: 'bslh-pre' }, h('code', null, blocks.map((block, index) => {
            const rows = block.spans.map((spans, offset) => renderLine(spans, block.from + offset + 1, referenceHooks));
            if (block.kind === 'plain') return rows;
            return h('div', {
              key: `routine:${block.symbol.line}`,
              className: 'bslh-routine',
              'data-routine': block.symbol.line,
              // Structure only: the routine the reader jumped into is marked, the
              // navigation itself happens on the framed references inside the text.
              'data-current': currentRoutine === block.symbol.line ? 'true' : undefined,
            }, rows);
          })))),
        portal,
      ]);
    }

    // ── Dictionaries ─────────────────────────────────────────────────────────

    /** Simplified Chinese: the shared source language of the shipped surfaces. */
    const zh = {
      title: '1C (BSL)',
      language: '1C',
      copy: '复制',
      copied: '已复制',
      empty: '空文件',
      lines: '{count} 行',
      back: '返回',
      nav: '方法和关系',
      navCount: '方法和关系（{count}）',
      tabList: '列表',
      external: '来自 cfsmcp2 的方法',
      externalLoading: '正在从 cfsmcp2 读取方法…',
      externalEmpty: '未找到方法',
      externalSource: '来源：cfsmcp2',
      externalNoBridge: '主机桥未加载',
      close: '关闭',
      symbols: '过程和函数',
      symbolsCount: '过程和函数：{count}',
      symbolsEmpty: '模块中没有过程和函数',
      go: '转到',
      cancel: '取消',
      help: '帮助',
      'helpText': '模块中所有过程和函数的列表。\n右侧显示所选过程的源码，使用与代码相同的语法高亮。\n双击行，或用 ↑ ↓ 选择后按 Enter / 「转到」，跳到对应的源码行。\n「排序」按名称排列，否则按模块中的顺序。Esc 关闭。',
      tree: '调用关系',
      treeCount: '过程和函数的调用关系：{count}',
      treeMode: '方向',
      modeCalls: '调用',
      modeCallers: '被调用',
      expand: '展开',
      collapse: '折叠',
      'linesRange': '{from}–{to} 行',
      previewEmpty: '未选择过程或函数',
      'treeHelpText': '模块中过程和函数的调用树，打开时已全部展开。\n「调用」显示当前过程调用了哪些过程和函数；「被调用」显示谁调用了它。\n右侧显示所选行的源码，带 1C 语法高亮。\n▸ 展开，▾ 折叠（也可用 ← →），双击或 Enter 跳到源码行。\n↻ 表示递归，展开到此为止。Esc 关闭。',
      sortByName: '排序',
      exported: '导出',
    };

    /** English fallback, checked against the zh key set. */
    const en = {
      title: '1C (BSL)',
      language: '1C',
      copy: 'Copy',
      copied: 'Copied',
      empty: 'Empty file',
      lines: '{count} lines',
      back: 'Back',
      nav: 'Methods',
      navCount: 'Methods ({count})',
      tabList: 'List',
      external: 'Method from cfsmcp2',
      externalLoading: 'Reading the method from cfsmcp2…',
      externalEmpty: 'The method was not found',
      externalSource: 'source: cfsmcp2',
      externalNoBridge: 'The host bridge is not loaded',
      close: 'Close',
      symbols: 'Procedures and functions',
      symbolsCount: 'Procedures and functions: {count}',
      symbolsEmpty: 'This module declares no procedures or functions',
      go: 'Go to',
      cancel: 'Cancel',
      help: 'Help',
      'helpText': 'Every procedure and function of this module.\nThe right pane shows the selected routine’s source with the same highlighting as the code.\nDouble-click a row, or select one with ↑ ↓ and press Enter or “Go to”, to jump to its source line.\n“Sort” orders the list by name instead of module order. Esc closes this dialog.',
      tree: 'Call tree',
      treeCount: 'Call relationships: {count}',
      treeMode: 'Direction',
      modeCalls: 'Calls',
      modeCallers: 'Called by',
      expand: 'Expand',
      collapse: 'Collapse',
      'linesRange': 'lines {from}–{to}',
      previewEmpty: 'No routine selected',
      'treeHelpText': 'The module’s routines as a call tree, opened unfolded.\n“Calls” shows what the selected routine calls; “Called by” shows who calls it.\nThe right pane shows the selected row’s source with the 1C highlighting.\n▸ expands, ▾ collapses (← → work too); double-click or Enter jumps to the source line.\n↻ marks recursion, where the tree stops. Esc closes this dialog.',
      sortByName: 'Sort',
      exported: 'export',
    };

    /** Russian, for sessions whose interface language is ru. */
    const ru = {
      title: '1C (BSL)',
      language: '1C',
      copy: 'Копировать',
      copied: 'Скопировано',
      empty: 'Пустой файл',
      lines: 'Строк: {count}',
      back: 'Назад',
      nav: 'Методы',
      navCount: 'Методы ({count})',
      tabList: 'Список',
      external: 'Метод из cfsmcp2',
      externalLoading: 'Читаю метод в cfsmcp2…',
      externalEmpty: 'Метод не найден',
      externalSource: 'источник: cfsmcp2',
      externalNoBridge: 'мост на хосте не загружен',
      close: 'Закрыть',
      symbols: 'Процедуры и функции',
      symbolsCount: 'Процедуры и функции: {count}',
      symbolsEmpty: 'В модуле нет процедур и функций',
      go: 'Перейти',
      cancel: 'Отмена',
      help: 'Справка',
      'helpText': 'Список всех процедур и функций модуля.\nСправа показывается исходник выбранного метода с той же разметкой, что и в коде.\nДвойной щелчок по строке или Enter (кнопка «Перейти») — переход к строке в коде.\n«Сортировка» — по имени вместо порядка в модуле. Esc — закрыть.',
      tree: 'Взаимосвязи',
      treeCount: 'Взаимосвязи процедур и функций: {count}',
      treeMode: 'Направление',
      modeCalls: 'Вызывает',
      modeCallers: 'Вызывают',
      expand: 'Раскрыть',
      collapse: 'Свернуть',
      'linesRange': 'строки {from}–{to}',
      previewEmpty: 'Метод не выбран',
      'treeHelpText': 'Дерево вызовов модуля, открывается развёрнутым.\n«Вызывает» — что вызывает выбранная процедура; «Вызывают» — кто вызывает её.\nСправа показывается исходник выбранной строки дерева с разметкой 1С.\n▸ раскрыть, ▾ свернуть (работают и ← →), двойной щелчок или Enter — переход к строке.\n↻ — рекурсия, дальше дерево не раскрывается. Esc — закрыть.',
      sortByName: 'Сортировка',
      exported: 'Экспорт',
    };

    return {
      /** Required browser services: the slot registry, the preview registry, copy. */
      inject: ['slots', 'documentPreviews', 'locale'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'bsl-lens: stylesheet');
        ctx.effect(() => ctx.locale.register(NS, { zh, en, ru }), 'bsl-lens: dictionaries');
        const t = ctx.locale.bind(NS);

        // `.bsl` / `.1c` are claimed at the default (extension) band, so this
        // renderer outranks the builtin plain-text fallback and every builtin
        // renderer whose suffix list does not cover the file.
        ctx.effect(() => ctx.documentPreviews.register({
          id: ID,
          extensions: EXTENSIONS,
          title: () => t('title'),
          loading: 'text-pages',
          wrap: true,
        }), 'bsl-lens: preview metadata');

        ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
          name: 'sidebar.right.tab.document',
          key: ID,
          locale: NS,
        }, BslBody)), 'bsl-lens: preview body');
      },
      /** Test seam: the scanner and its palette, for the Node test suite. */
      __bsl: { tokenize: tokenizeBsl, collectSymbols, analyzeModule, buildTreeRows, allTreeKeys, segmentModule, routineAt, commentOnlyLine, sortedSymbols, SymbolsList, NavDialog, ExternalDialog, looksLikeExternalModule, TreeView, CodePreview, BackButton, focusElement, TOKEN_STYLE, CONFIGURATOR, CSS, EXTENSIONS, ID },
    };
  },
});
