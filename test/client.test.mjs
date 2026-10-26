/**
 * Node-side proof for the browser bundle.
 *
 * `client.js` is a lazy-CJS browser bundle: it calls
 * `window.__ModuleLoader__.load({...})` and requires React from the shared
 * table. This suite installs a stub loader and a stub `require`, captures the
 * factory, and exercises the two things that can be wrong without a browser:
 * the 1C scanner and the shape of the registrations `apply` performs.
 *
 * Run with `node --test test/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, '..', 'client.js');

/**
 * Hook host for tests that need real state, refs and effects.
 *
 * The renderer stub below stays stateless by default; a test that has to watch a
 * component open, close and move focus installs a host first and drives the
 * re-renders itself. Hooks are addressed by their position in the render, the
 * way React addresses them, so the order must stay stable — which it does,
 * because the component calls its hooks unconditionally.
 */
function createHookHost() {
  const states = new Map();
  const refs = new Map();
  const deps = new Map();
  const cleanups = new Map();
  let slot = 0;

  return {
    /** Render one pass of the component under test. */
    render(component) {
      slot = 0;
      return component();
    },
    useState(initial) {
      const at = slot;
      slot += 1;
      if (!states.has(at)) states.set(at, typeof initial === 'function' ? initial() : initial);
      const set = (next) => {
        const value = typeof next === 'function' ? next(states.get(at)) : next;
        if (Object.is(value, states.get(at))) return;
        states.set(at, value);
      };
      return [states.get(at), set];
    },
    useRef(initial) {
      const at = slot;
      slot += 1;
      if (!refs.has(at)) refs.set(at, { current: initial ?? null });
      return refs.get(at);
    },
    useEffect(fn, dependencies) {
      const at = slot;
      slot += 1;
      const previous = deps.get(at);
      const changed = previous === undefined
        || dependencies === undefined
        || dependencies.length !== previous.length
        || dependencies.some((value, index) => !Object.is(value, previous[index]));
      if (!changed) return;
      deps.set(at, dependencies);
      const cleanup = cleanups.get(at);
      if (typeof cleanup === 'function') cleanup();
      const produced = fn();
      cleanups.set(at, typeof produced === 'function' ? produced : undefined);
    },
    unmount() {
      for (const cleanup of cleanups.values()) if (typeof cleanup === 'function') cleanup();
      cleanups.clear();
    },
  };
}

/** The host installed by the running test; null means the stateless stub. */
let hookHost = null;

/** Minimal React stand-in: the module body uses hooks, the tests call them directly. */
const reactStub = {
  // React flattens array children; the stub does the same so call sites read alike.
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useState: (initial) => (hookHost === null ? [initial, () => {}] : hookHost.useState(initial)),
  useRef: (initial) => (hookHost === null ? { current: initial ?? null } : hookHost.useRef(initial)),
  useEffect: (fn, dependencies) => {
    if (hookHost !== null) hookHost.useEffect(fn, dependencies);
  },
};

/**
 * Load the bundle through the loader facade it expects.
 * @returns the factory's exports.
 */
async function loadBundle() {
  const definitions = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definitions.push(value);
      },
    },
  };
  const source = await readFile(CLIENT, 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(/u, 'bundle must register through the loader facade');
  await import(`${CLIENT}?t=${String(Date.now())}`);
  assert.ok(definitions.length > 0, 'bundle called the loader');
  const ids = definitions.map((entry) => entry.id);
  assert.equal(ids[0], 'dsh-bsl-lens', 'the bundle id is the package name');
  assert.deepEqual(ids.slice(1), ['@local/dsh-bsl-highlight'], 'and the pre-rename id keeps working');
  for (const entry of definitions) {
    assert.equal(typeof entry.factory, 'function', `factory for ${entry.id}`);
  }
  const exports = definitions[0].factory((request) => {
    if (request === 'react') return reactStub;
    if (request === '@deepseek-ai/dsh-client-ui-primitives') return {};
    throw new Error(`unexpected require(${JSON.stringify(request)})`);
  });
  return exports;
}

const bundle = await loadBundle();
const { tokenize } = bundle.__bsl;

/**
 * Flatten one line's spans to `class:text` pairs, dropping plain runs.
 * @param spans - one line from the scanner.
 * @returns styled runs only.
 */
const styled = (spans) => spans.filter((span) => span.t !== 'txt').map((span) => `${span.t}:${span.s}`);

test('a procedure declaration is a keyword with a call site', () => {
  const lines = tokenize('Процедура ОбработатьЗаказ(Заказ) Экспорт');
  assert.deepEqual(styled(lines[0]), [
    'kw:Процедура',
    'fn:ОбработатьЗаказ',
    'pun:(',
    'id:Заказ',
    'pun:)',
    'kw:Экспорт',
  ]);
});

test('keywords are case-insensitive in both spellings', () => {
  for (const source of ['ЕСЛИ Истина ТОГДА', 'If True Then', 'если истина тогда']) {
    const runs = styled(tokenize(source)[0]);
    assert.equal(runs.length, 3, source);
    assert.ok(runs[0].startsWith('kw:'), source);
    assert.ok(runs[2].startsWith('kw:'), source);
  }
});

test('constants are not keywords', () => {
  const lines = tokenize('Результат = Неопределено;');
  assert.ok(styled(lines[0]).includes('con:Неопределено'));
});

test('a line comment wins over operators and strings', () => {
  const lines = tokenize('// Сообщить("x"); if');
  assert.deepEqual(styled(lines[0]), ['com:// Сообщить("x"); if']);
});

test('strings survive doubled quotes and never leak a comment', () => {
  const lines = tokenize('Текст = "он сказал ""да"" // не комментарий";');
  const runs = styled(lines[0]);
  assert.ok(runs.includes('str:"он сказал ""да"" // не комментарий"'), runs.join(' | '));
  assert.equal(runs.filter((run) => run.startsWith('com:')).length, 0);
});

test('a multi-line string keeps its continuation marker inside the token', () => {
  const lines = tokenize('Текст = "первая\n|вторая\n|третья";');
  assert.equal(lines.length, 3);
  assert.deepEqual(styled(lines[0]).at(-1), 'str:"первая');
  assert.deepEqual(styled(lines[1]), ['str:|вторая']);
  assert.deepEqual(styled(lines[2]), ['str:|третья"', 'pun:;']);
});

test('date literals and numbers are value tokens', () => {
  const lines = tokenize("Дата = '20240101120000'; Число = 1.5;");
  const runs = styled(lines[0]);
  assert.ok(runs.includes("num:'20240101120000'"), runs.join(' | '));
  assert.ok(runs.includes('num:1.5'), runs.join(' | '));
});

test('preprocessor directives and annotations are distinct from keywords', () => {
  const directive = styled(tokenize('#Область ПрограммныйИнтерфейс')[0]);
  assert.deepEqual(directive[0], 'ann:#Область');
  const annotation = styled(tokenize('&НаКлиенте\nПроцедура Тест()')[0]);
  assert.deepEqual(annotation, ['ann:&НаКлиенте']);
  // `#` is only a directive where one may start.
  const hash = styled(tokenize('А = оставить#1')[0]);
  assert.ok(hash.includes('pun:#'), hash.join(' | '));
});

test('metadata types, manager collections and members are painted', () => {
  const runs = styled(tokenize('Справочники.Товары.ПолучитьСсылку(Истина)')[0]);
  assert.deepEqual(runs, [
    'type:Справочники',
    'pun:.',
    'fn:Товары',
    'pun:.',
    'fn:ПолучитьСсылку',
    'pun:(',
    'con:Истина',
    'pun:)',
  ]);

  const generated = styled(tokenize('Объект = Новый СправочникОбъект.Товары;\nСсылка = СправочникСсылка.Товары;')[0]);
  assert.ok(generated.includes('type:СправочникОбъект'), generated.join(' | '));
  assert.deepEqual(
    styled(tokenize('Ссылка = СправочникСсылка.Товары;')[0]).slice(0, 3),
    ['id:Ссылка', 'pun:=', 'type:СправочникСсылка'],
  );
});

test('a camelCase local is not mistaken for a metadata type', () => {
  const runs = styled(tokenize('documentText = documentCount + 1;')[0]);
  assert.deepEqual(runs.filter((run) => run.startsWith('type:')), []);
});

test('a member after a dot beats the keyword of the same spelling', () => {
  // `Запрос.Выполнить()` is a method call; `Выполнить` alone is the keyword.
  assert.deepEqual(styled(tokenize('Запрос.Выполнить();')[0]), ['id:Запрос', 'pun:.', 'fn:Выполнить', 'pun:();']);
  assert.deepEqual(styled(tokenize('Выполнить("Код");')[0]), ['kw:Выполнить', 'pun:(', 'str:"Код"', 'pun:);']);
});

test('a file closing with a newline does not gain a phantom line', () => {
  assert.equal(tokenize('А = 1;\n').length, 1);
  assert.equal(tokenize('А = 1;\n\n').length, 2);
});

test('empty source has exactly one renderable line', () => {
  assert.deepEqual(tokenize(''), [[]]);
});

test('the scanner never throws on hostile input', () => {
  const samples = ['"незакрытая строка', "'2024", '#', '&', '//', 'А.Б.В', '"""', '<<<>>>', 'Ё', '🔥'];
  for (const sample of samples) assert.doesNotThrow(() => tokenize(sample), sample);
});

test('procedures and functions are collected with kind, line and export', () => {
  const { collectSymbols } = bundle.__bsl;
  const source = [
    '#Область ПрограммныйИнтерфейс',
    '',
    '// Формирует движения.',
    '&НаСервере',
    'Процедура СформироватьДвижения(ДокументСсылка, Отказ = Ложь) Экспорт',
    '',
    'КонецПроцедуры',
    '',
    'Функция СуммаПоТоварам(Товары)',
    '',
    'КонецФункции',
    '',
    'Асинх Процедура ЗагрузитьАсинхронно()',
    '',
    'КонецПроцедуры',
    '',
    'Процедура Внутренняя()',
    '',
    'КонецПроцедуры',
    '',
    '#КонецОбласти',
  ].join('\n');
  const symbols = collectSymbols(tokenize(source));
  assert.deepEqual(symbols, [
    { name: 'СформироватьДвижения', kind: 'procedure', line: 5, exported: true },
    { name: 'СуммаПоТоварам', kind: 'function', line: 9, exported: false },
    { name: 'ЗагрузитьАсинхронно', kind: 'procedure', line: 13, exported: false },
    { name: 'Внутренняя', kind: 'procedure', line: 17, exported: false },
  ]);
});

test('routine collection is not fooled by comments, strings or calls', () => {
  const { collectSymbols } = bundle.__bsl;
  const source = [
    '// Процедура в комментарии не считается',
    'Текст = "Функция в строке тоже";',
    'Список.Добавить("Процедура");',
    'Процедура Настоящая() Экспорт',
    'КонецПроцедуры',
    'Функция',
  ].join('\n');
  assert.deepEqual(collectSymbols(tokenize(source)), [
    { name: 'Настоящая', kind: 'procedure', line: 4, exported: true },
  ]);
});

test('English declarations are collected too', () => {
  const { collectSymbols } = bundle.__bsl;
  const symbols = collectSymbols(tokenize('Procedure Test() Export\nEndProcedure\nFunction Value(Item)\nEndFunction'));
  assert.deepEqual(symbols.map((symbol) => [symbol.kind, symbol.name, symbol.exported]), [
    ['procedure', 'Test', true],
    ['function', 'Value', false],
  ]);
});

test('sorting reorders by name without touching the source order', () => {
  const { sortedSymbols } = bundle.__bsl;
  const symbols = [
    { name: 'Яблоко', kind: 'function', line: 9, exported: false },
    { name: 'абрикос', kind: 'procedure', line: 3, exported: false },
    { name: 'Груша', kind: 'procedure', line: 6, exported: false },
  ];
  assert.deepEqual(sortedSymbols(symbols, false).map((s) => s.name), ['Яблоко', 'абрикос', 'Груша']);
  assert.deepEqual(sortedSymbols(symbols, true).map((s) => s.name), ['абрикос', 'Груша', 'Яблоко']);
  assert.deepEqual(symbols.map((s) => s.name), ['Яблоко', 'абрикос', 'Груша'], 'input untouched');
});

test('the page is cut into frames exactly where the routines are', () => {
  const { analyzeModule, segmentModule, routineAt, tokenize } = bundle.__bsl;
  const source = [
    '#Область Тест',
    '',
    'Процедура Первая()',
    'КонецПроцедуры',
    '',
    'Функция Вторая()',
    '\tВозврат 1;',
    'КонецФункции',
    '',
    '#КонецОбласти',
  ].join('\n');
  const lines = tokenize(source);
  const { symbols } = analyzeModule(lines);
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.line, symbol.endLine]), [
    ['Первая', 3, 4],
    ['Вторая', 6, 8],
  ]);

  const blocks = segmentModule(lines, symbols);
  assert.deepEqual(blocks.map((entry) => [entry.kind, entry.from, entry.to]), [
    ['plain', 0, 2],      // region header and the blank line
    ['routine', 2, 4],    // Первая, lines 3–4
    ['plain', 4, 5],      // blank line between routines
    ['routine', 5, 8],    // Вторая, lines 6–8
    ['plain', 8, 10],     // blank line and #КонецОбласти
  ]);
  assert.deepEqual(blocks.map((entry) => entry.spans.length), [2, 2, 1, 3, 2], 'each block owns its slice');

  assert.equal(routineAt(symbols, 1), 0, 'a line above every routine belongs to none');
  assert.equal(routineAt(symbols, 3), 3);
  assert.equal(routineAt(symbols, 4), 3, 'the closing keyword is part of the frame');
  assert.equal(routineAt(symbols, 5), 0, 'the gap is not a routine');
  assert.equal(routineAt(symbols, 7), 6);
});

test('a doc comment above a declaration joins the frame', () => {
  const { analyzeModule, segmentModule, commentOnlyLine, tokenize } = bundle.__bsl;
  const source = [
    '#Область Тест',            // 1
    '// Документирует Первую.',  // 2
    '// Две строки подряд.',     // 3
    'Процедура Первая()',        // 4
    'КонецПроцедуры',            // 5
    '',                          // 6
    'ОбычнаяСтрока = 1;',        // 7 — not a comment, so it stays outside
    'Функция Вторая()',          // 8
    'КонецФункции',              // 9
  ].join('\n');
  const lines = tokenize(source);
  const { symbols } = analyzeModule(lines);
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.line, symbol.endLine]), [
    ['Первая', 4, 5],
    ['Вторая', 8, 9],
  ]);

  const blocks = segmentModule(lines, symbols);
  assert.deepEqual(blocks.map((entry) => [entry.kind, entry.from, entry.to]), [
    ['plain', 0, 1],      // #Область
    ['routine', 1, 5],    // both comment lines and the routine
    ['plain', 5, 7],      // the blank line and the ordinary statement
    ['routine', 7, 9],    // Вторая
  ]);

  assert.equal(commentOnlyLine(tokenize('// да')[0]), true);
  assert.equal(commentOnlyLine(tokenize('#Область Тест')[0]), false, 'a directive is not a comment');
  assert.equal(commentOnlyLine(tokenize('Процедура X()')[0]), false);
  assert.equal(commentOnlyLine([]), false, 'an empty line is not a comment');
});

test('a framed reference jumps to the routine and «Назад» comes back', () => {
  const seen = [];
  bundle.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    documentPreviews: { register: () => () => {} },
    slots: {
      inject: (_name, register) => {
        seen.push(register());
        return () => {};
      },
      register: (spec, component) => ({ spec, component }),
    },
  });
  const Body = seen[0].component;

  hookHost = createHookHost();
  try {
    const props = {
      content: {
        kind: 'text',
        text: [
          'Процедура Первая()',      // 1
          '\tВторая();',              // 2 — bare call: a reference
          '\tОбъект.Вторая();',       // 3 — member call: not a reference
          'КонецПроцедуры',           // 4
          '',                         // 5
          'Функция Вторая()',         // 6
          'КонецФункции',             // 7
        ].join('\n'),
        eof: true,
      },
      wrap: false,
      scrollportRef: null,
      t: (key) => key,
    };
    const body = () => Body(props);
    // React flattens nested children arrays; the stub flattens one level, so do the rest here.
    const page = (rendered) => rendered.children[1].children[0].children[0].children.flat();
    const frames = (rendered) => page(rendered).filter((node) => node.props.className === 'bslh-routine');
    const toolbar = (rendered) => rendered.children[0].children[0].children[0].props;
    const refsIn = (frame) => frame.children
      .flatMap((line) => line.children[1].children)
      .filter((node) => typeof node === 'object' && node.props.className === 'bslh-ref');

    let tree = hookHost.render(body);
    assert.equal(toolbar(tree).canBack, false, '«Назад» starts disabled');

    const first = refsIn(frames(tree)[0]);
    assert.equal(first.length, 1, 'only the bare call is framed');
    assert.equal(first[0].props['data-ref'], 6, 'the frame points at Вторая, line 6');
    assert.equal(first[0].children[0], 'Вторая');
    assert.equal(first[0].props.role, 'link');

    // Click the framed call inside Первая.
    first[0].props.onClick({ type: 'click', stopPropagation() {} });
    tree = hookHost.render(body);
    assert.equal(frames(tree)[0].props['data-current'], undefined);
    assert.equal(frames(tree)[1].props['data-current'], 'true', 'the target routine is marked current');
    assert.equal(toolbar(tree).canBack, true, 'now there is a way back');

    // A member call never becomes a reference, so nothing else is framed.
    assert.equal(refsIn(frames(tree)[1]).length, 0);

    toolbar(tree).onClick();
    tree = hookHost.render(body);
    assert.equal(frames(tree)[0].props['data-current'], 'true', 'back returns to the routine the click came from');
    assert.equal(frames(tree)[1].props['data-current'], undefined);
    assert.equal(toolbar(tree).canBack, false, 'and the trail is empty again');
  } finally {
    hookHost = null;
  }
});

test('the dialog lists every routine the Configurator way', () => {
  const { NavDialog, SymbolsList } = bundle.__bsl;
  const t = (key, params) => {
    const dict = { nav: 'Методы', go: 'Перейти', cancel: 'Отмена', help: 'Справка', sortByName: 'Сортировка', exported: 'Экспорт', helpText: 'hint', tabList: 'Список', modeCalls: 'Вызывает', modeCallers: 'Вызывают' };
    let out = dict[key] ?? key;
    if (params !== undefined) for (const [name, value] of Object.entries(params)) out = out.replace(`{${name}}`, String(value));
    return out;
  };
  const symbols = [
    { name: 'Первая', kind: 'procedure', line: 3, exported: true },
    { name: 'Вторая', kind: 'function', line: 12, exported: false },
  ];
  const dialog = NavDialog({
    tabs: [
      { key: 'calls', label: 'Вызывает' },
      { key: 'callers', label: 'Вызывают' },
      { key: 'list', label: 'Список' },
    ],
    tab: 'list',
    onTab: () => {},
    pane: SymbolsList({ symbols, activeIndex: 1, onActivate: () => {}, onGo: () => {}, t }),
    preview: { name: 'Вторая', kind: 'function', from: 12, to: 15, spans: [] },
    hooks: { lookup: () => undefined, go: () => {} },
    canBack: false,
    onBack: () => {},
    sorted: true,
    onToggleSort: () => {},
    help: false,
    helpText: 'hint',
    goDisabled: false,
    onGo: () => {},
    onCancel: () => {},
    onToggleHelp: () => {},
    onMove: () => {},
    t,
  });

  assert.equal(dialog.props.className, 'bslh-modal');
  const card = dialog.children[0];
  assert.equal(card.props.className, 'bslh-dialog bslh-dialog-wide');
  assert.equal(card.props.role, 'dialog');
  const [head, main, foot, help] = card.children;
  const tabs = head.children[0];
  assert.equal(tabs.props.role, 'tablist');
  assert.deepEqual(tabs.children.map((tab) => tab.children[0]), ['Вызывает', 'Вызывают', 'Список'], 'the list tab comes last');
  assert.equal(tabs.children[2].props['data-active'], 'true', 'the requested tab is the active one');
  assert.equal(tabs.children[1].props['data-active'], 'false');
  assert.equal(help, null, 'help is closed by default');

  const [left, code] = main.children;
  assert.equal(left.props.className, 'bslh-pane-left');
  assert.equal(code.props.preview.name, 'Вторая', 'the right pane previews the active row');
  const list = left.children[0];
  assert.equal(list.props.role, 'listbox');
  assert.equal(list.children.length, 2);
  const [first, second] = list.children;
  assert.equal(first.props.id, 'bslh-symbol-0');
  assert.equal(first.props['aria-selected'], 'false');
  assert.equal(second.props['aria-selected'], 'true', 'the active row is not the first');
  assert.equal(second.children[0].children[0], 'F', 'functions get the F badge');
  assert.equal(second.children[1].children[0], 'Вторая');
  assert.equal(second.children[2].children[0], '12', 'the source line rides along');
  assert.equal(first.children[2].children[0], 'Экспорт', 'exported routines say so');

  assert.equal(foot.props.className, 'bslh-dialog-foot');
  assert.equal(foot.children[0].props.className, 'bslh-sort', 'the sort box leads the footer');
  assert.equal(foot.children[0].children[0].props.checked, true, 'the sort box mirrors the state');
  const labels = foot.children.slice(2).map((child) => child.children[0]);
  assert.deepEqual(labels, ['Перейти', 'Отмена', 'Справка']);
  assert.equal(foot.children[2].props['data-primary'], 'true', 'Перейти is the default button');
});

test('an empty module says so instead of showing an empty list', () => {
  const { NavDialog, SymbolsList } = bundle.__bsl;
  const dialog = NavDialog({
    tabs: [{ key: 'list', label: 'Список' }],
    tab: 'list',
    onTab: () => {},
    pane: SymbolsList({ symbols: [], activeIndex: 0, onActivate: () => {}, onGo: () => {}, t: (key) => key }),
    preview: null,
    hooks: { lookup: () => undefined, go: () => {} },
    canBack: false,
    onBack: () => {},
    help: false,
    helpText: '',
    goDisabled: true,
    onGo: () => {},
    onCancel: () => {},
    onToggleHelp: () => {},
    onMove: () => {},
    t: (key) => key,
  });
  const [, main, foot] = dialog.children[0].children;
  const [left, code] = main.children;
  assert.equal(left.children[0].props.className, 'bslh-symbols', 'an empty listbox is still a listbox');
  assert.equal(left.children[0].children.length, 0);
  assert.equal(code.props.preview, null, 'no routine, nothing to preview');
  // Without the sort box the footer is [spacer, go, cancel, help].
  assert.deepEqual(foot.children.slice(1).map((child) => child.children[0]), ['go', 'cancel', 'help']);
  assert.equal(foot.children[1].props.disabled, true, 'Перейти cannot act on nothing');
});

test('the call graph keeps bare calls and drops member calls', () => {
  const { analyzeModule } = bundle.__bsl;
  const source = [
    'Процедура Начать() Экспорт',
    '\tПодготовить();',
    '\tОбработать();',
    'КонецПроцедуры',
    '',
    'Процедура Подготовить()',
    '\tОчистить();',
    'КонецПроцедуры',
    '',
    'Функция Обработать() Экспорт',
    '\tПодготовить();',
    '\tВозврат Обработать();',
    'КонецФункции',
    '',
    'Процедура Очистить()',
    '\tОбъект.Очистить();',
    'КонецПроцедуры',
  ].join('\n');
  const { symbols, callers } = analyzeModule(tokenize(source));

  assert.deepEqual(symbols.map((symbol) => symbol.name), ['Начать', 'Подготовить', 'Обработать', 'Очистить']);
  assert.deepEqual(symbols.map((symbol) => symbol.line), [1, 6, 10, 15]);
  assert.deepEqual(symbols.map((symbol) => symbol.endLine), [4, 8, 13, 17], 'the closing keyword ends the body');
  assert.deepEqual(symbols.map((symbol) => symbol.calls), [[1, 2], [3], [1, 2], []], 'member calls never become edges');
  assert.deepEqual(callers, [[], [0, 2], [0, 2], [1]], 'inverse edges');
});

test('the tree unfolds in both directions, marks cycles and stops there', () => {
  const { analyzeModule, buildTreeRows } = bundle.__bsl;
  const source = [
    'Процедура Начать()',
    '\tПодготовить();',
    '\tОбработать();',
    'КонецПроцедуры',
    'Процедура Подготовить()',
    'КонецПроцедуры',
    'Функция Обработать()',
    '\tПодготовить();',
    '\tВозврат Обработать();',
    'КонецФункции',
  ].join('\n');
  const { symbols, callers } = analyzeModule(tokenize(source));

  const collapsed = buildTreeRows(symbols, callers, 'calls', new Set());
  assert.equal(collapsed.length, 3, 'roots only');
  assert.deepEqual(collapsed.map((row) => [row.name, row.depth, row.count]), [
    ['Начать', 0, 2],
    ['Подготовить', 0, 0],
    ['Обработать', 0, 2],
  ]);
  assert.equal(collapsed[0].parent, -1);

  const opened = buildTreeRows(symbols, callers, 'calls', new Set(['0', '0>2']));
  assert.deepEqual(opened.map((row) => [row.depth, row.name, row.cycle]), [
    [0, 'Начать', false],
    [1, 'Подготовить', false],
    [1, 'Обработать', false],
    [2, 'Подготовить', false],
    [2, 'Обработать', true],
    [0, 'Подготовить', false],
    [0, 'Обработать', false],
  ]);
  assert.equal(opened[4].key, '0>2>2', 'keys are paths, so a routine may repeat in the tree');
  assert.equal(opened[2].parent, 0, 'a row knows its parent for ← navigation');

  const inverted = buildTreeRows(symbols, callers, 'callers', new Set(['2']));
  assert.deepEqual(inverted.slice(3, 5).map((row) => [row.depth, row.name, row.cycle]), [
    [1, 'Начать', false],
    [1, 'Обработать', true],
  ], '«Вызывают» answers with the callers');
});

test('a tree opens fully unfolded, and the cap keeps it finite', () => {
  const { analyzeModule, buildTreeRows, allTreeKeys } = bundle.__bsl;
  const source = [
    'Процедура Начать()',
    '\tПодготовить();',
    '\tОбработать();',
    'КонецПроцедуры',
    'Процедура Подготовить()',
    'КонецПроцедуры',
    'Функция Обработать()',
    '\tПодготовить();',
    '\tВозврат Обработать();',
    'КонецФункции',
  ].join('\n');
  const { symbols, callers } = analyzeModule(tokenize(source));

  const forward = [...allTreeKeys(symbols, callers, 'calls')].sort();
  assert.deepEqual(forward, ['0', '0>2', '2'], 'every branch that can open, opens');
  const forwardRows = buildTreeRows(symbols, callers, 'calls', allTreeKeys(symbols, callers, 'calls'));
  assert.equal(forwardRows.length, 9, 'roots plus every unfolded branch');

  const backward = [...allTreeKeys(symbols, callers, 'callers')].sort();
  assert.deepEqual(backward, ['1', '1>2', '2']);
  assert.equal(buildTreeRows(symbols, callers, 'callers', new Set(backward)).length, 9);

  const capped = allTreeKeys(symbols, callers, 'calls', 1);
  assert.equal(capped.size, 1, 'the cap stops the walk');
});

test('the tree tab draws indented, expandable rows', () => {
  const { NavDialog, TreeView } = bundle.__bsl;
  const t = (key) => key;
  const rows = [
    { key: '0', depth: 0, index: 0, name: 'Начать', kind: 'procedure', line: 1, exported: false, cycle: false, expandable: true, expanded: true, count: 2, parent: -1 },
    { key: '0>1', depth: 1, index: 1, name: 'Подготовить', kind: 'function', line: 6, exported: true, cycle: false, expandable: false, expanded: false, count: 0, parent: 0 },
    { key: '0>1>1', depth: 2, index: 1, name: 'Подготовить', kind: 'function', line: 6, exported: true, cycle: true, expandable: false, expanded: false, count: 0, parent: 1 },
  ];
  const dialog = NavDialog({
    tabs: [
      { key: 'list', label: 'Список' },
      { key: 'calls', label: 'Вызывает' },
      { key: 'callers', label: 'Вызывают' },
    ],
    tab: 'calls',
    onTab: () => {},
    pane: TreeView({ rows, activeIndex: 1, onActivate: () => {}, onToggleRow: () => {}, onGo: () => {}, t }),
    preview: { name: 'Подготовить', kind: 'function', from: 6, to: 8, spans: [] },
    hooks: { lookup: () => undefined, go: () => {} },
    canBack: false,
    onBack: () => {},
    help: false,
    helpText: 'treeHelpText',
    goDisabled: false,
    onGo: () => {},
    onCancel: () => {},
    onToggleHelp: () => {},
    onMove: () => {},
    onHorizontal: () => {},
    t,
  });

  const card = dialog.children[0];
  const [head, main, foot] = card.children;
  const tabs = head.children[0];
  // Fixture order: Список, Вызывает, Вызывают — the tree tab is the second.
  assert.equal(tabs.children[1].props['data-active'], 'true', 'the tree tab is the active one');

  const [left, code] = main.children;
  assert.equal(code.props.preview.name, 'Подготовить', 'the right pane previews the active row');
  // The back button is handed to the preview and renders above the code.
  assert.equal(typeof code.props.onBack, 'function', 'the preview gets the back handler');
  assert.equal(code.props.canBack, false);
  assert.equal(left.children[0].type, 'ul', 'the tab strip is gone: the tabs live in the header');

  const tree = TreeView({ rows, activeIndex: 1, onActivate: () => {}, onToggleRow: () => {}, onGo: () => {}, t });
  const nodes = tree.children;
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map((node) => node.props['data-depth']), [0, 1, 2]);
  assert.equal(nodes[1].props.style.paddingLeft, '24px', 'depth becomes indentation');
  assert.equal(nodes[0].props['aria-expanded'], 'true');
  assert.equal(nodes[0].children[0].children[0], '▾', 'an open row shows the down triangle');
  assert.equal(nodes[1].children[0].children[0], '·', 'a leaf shows no triangle');
  assert.equal(nodes[1].props['aria-selected'], 'true', 'the active row is the second one');
  assert.equal(nodes[2].children.find((cell) => cell.props.className === 'bslh-cycle').children[0], '↻', 'a cycle is marked');
  assert.deepEqual(foot.children.slice(1).map((child) => child.children[0]), ['go', 'cancel', 'help']);
});

test('the preview pane paints the routine with the page palette', () => {
  const { CodePreview, tokenize, analyzeModule } = bundle.__bsl;
  const source = ['Процедура Начать() Экспорт', '\tПодготовить();', 'КонецПроцедуры', ''].join('\n');
  const lines = tokenize(source);
  const { symbols } = analyzeModule(lines);
  const symbol = symbols[0];
  const preview = {
    name: symbol.name,
    kind: symbol.kind,
    from: symbol.line,
    to: symbol.endLine,
    spans: lines.slice(symbol.line - 1, symbol.endLine),
  };

  const pane = CodePreview({ preview, t: (key, params) => {
    if (key === 'linesRange') return `строки ${params.from}–${params.to}`;
    return key;
  } });
  assert.equal(pane.props.className, 'bslh-pane-code');
  assert.equal(pane.props.style['--bslh-gutter'], '1ch');
  const [caption, scroll] = pane.children;
  assert.equal(caption.props.className, 'bslh-pane-caption');
  assert.equal(caption.children[0].children[0], 'P', 'the kind badge carries over');
  assert.equal(caption.children[1].children[0], 'Начать');
  assert.equal(caption.children[2].children[0], 'строки 1–3');

  const pre = scroll.children[0];
  const rows = pre.children[0].children;
  assert.equal(rows.length, 3, 'the whole body, end keyword included');
  assert.deepEqual(rows.map((row) => row.props['data-textpreview-line']), [1, 2, 3], 'file line numbers, not pane-relative ones');
  // A leading tab is a bare text child, so take the first painted run, not the first child.
  const firstRun = (row) => row.children[1].children.find((cell) => typeof cell === 'object');
  assert.equal(firstRun(rows[0]).props.style.color, '#ff0000', 'keywords are red like on the page');
  assert.equal(firstRun(rows[1]).props.style.color, '#0000ff', 'calls are identifiers blue');
});

test('an empty preview says so', () => {
  const { CodePreview } = bundle.__bsl;
  const pane = CodePreview({ preview: null, t: (key) => key });
  assert.equal(pane.children[0].props.className, 'bslh-status');
});

test('closing a dialog gives the keyboard back to its button', () => {
  const { focusElement } = bundle.__bsl;
  let focused = 0;
  const button = { focus() { focused += 1; } };
  assert.equal(focusElement(button), true);
  assert.equal(focused, 1, 'the trigger takes focus back');
  assert.equal(focusElement(null), false, 'nothing to focus');
  assert.equal(focusElement(undefined), false);
  assert.equal(focusElement({}), false, 'a node that cannot focus is not an error');
});

test('Escape closes the dialog and puts the keyboard back on its button', () => {
  const seen = [];
  bundle.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    documentPreviews: { register: () => () => {} },
    slots: {
      inject: (_name, register) => {
        seen.push(register());
        return () => {};
      },
      register: (spec, component) => ({ spec, component }),
    },
  });
  const Body = seen[0].component;

  // A window that records the listeners the dialog installs.
  const listeners = [];
  globalThis.window.addEventListener = (type, fn) => listeners.push({ type, fn });
  globalThis.window.removeEventListener = (type, fn) => {
    const at = listeners.findIndex((entry) => entry.fn === fn);
    if (at >= 0) listeners.splice(at, 1);
  };

  const focused = [];
  const trigger = { focus: () => focused.push('nav') };

  hookHost = createHookHost();
  try {
    const props = {
      content: { kind: 'text', text: 'Процедура Тест()\n\nКонецПроцедуры\n', eof: true },
      wrap: false,
      scrollportRef: null,
      t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    };
    const body = () => Body(props);

    let tree = hookHost.render(body);
    const navButton = tree.children[0].children[0].children[1];
    // The button's ref is the anchor the dialog returns focus to.
    navButton.props.ref.current = trigger;
    assert.equal(listeners.length, 0, 'no key listener while the dialog is closed');

    // The one overlay slot is an array child of the pane root.
    const overlay = (rendered) => {
      const slot = rendered.children[2];
      return Array.isArray(slot) ? (slot.find(Boolean) ?? null) : (slot ?? null);
    };

    navButton.props.onClick();
    tree = hookHost.render(body);
    // The body returns the dialog *element*; the stub does not mount children.
    assert.equal(overlay(tree).type, bundle.__bsl.NavDialog, 'the dialog is open');
    const escape = listeners.find((entry) => entry.type === 'keydown');
    assert.ok(escape !== undefined, 'the open dialog captures Escape on the window');

    escape.fn({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(focused, ['nav'], 'focus went back to the button that opened the dialog');

    tree = hookHost.render(body);
    assert.equal(overlay(tree), null, 'the dialog is closed');
    assert.equal(listeners.length, 0, 'the listener goes away with the dialog');

    // «Перейти» closes the same way, so the keyboard never falls to the document.
    focused.length = 0;
    navButton.props.onClick();
    tree = hookHost.render(body);
    overlay(tree).props.onGo();
    assert.deepEqual(focused, ['nav'], 'a jump also restores the opener');
    tree = hookHost.render(body);
    assert.equal(overlay(tree), null, 'the jump closes the dialog');
  } finally {
    hookHost = null;
  }
});

test('the tabs switch the pane and keep the dialog open', () => {
  const seen = [];
  bundle.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    documentPreviews: { register: () => () => {} },
    slots: {
      inject: (_name, register) => {
        seen.push(register());
        return () => {};
      },
      register: (spec, component) => ({ spec, component }),
    },
  });
  const Body = seen[0].component;

  hookHost = createHookHost();
  try {
    const props = {
      content: {
        kind: 'text',
        text: ['Процедура Первая()', '\tВторая();', 'КонецПроцедуры', '', 'Функция Вторая()', 'КонецФункции'].join('\n'),
        eof: true,
      },
      wrap: false,
      scrollportRef: null,
      t: (key) => key,
    };
    const body = () => Body(props);
    const overlay = (rendered) => {
      const slot = rendered.children[2];
      return Array.isArray(slot) ? (slot.find(Boolean) ?? null) : (slot ?? null);
    };

    let tree = hookHost.render(body);
    tree.children[0].children[0].children[1].props.onClick();   // open the dialog
    tree = hookHost.render(body);
    let dialog = overlay(tree);
    assert.equal(dialog.props.tab, 'calls', 'it opens on «Вызывает»');
    assert.deepEqual(dialog.props.tabs.map((entry) => entry.key), ['calls', 'callers', 'list'], 'the list tab comes last');
    assert.equal(dialog.props.onToggleSort, undefined, 'the sort box belongs to the list tab');

    dialog.props.onTab('callers');
    tree = hookHost.render(body);
    dialog = overlay(tree);
    assert.equal(dialog.props.tab, 'callers', 'the dialog stays open on another tab');

    dialog.props.onTab('list');
    tree = hookHost.render(body);
    dialog = overlay(tree);
    assert.equal(dialog.props.tab, 'list', 'the dialog stays open on the list tab');
    assert.equal(typeof dialog.props.onToggleSort, 'function', 'the list tab brings the sort box back');

    // Closing and reopening always lands back on «Вызывает».
    dialog.props.onCancel();
    tree = hookHost.render(body);
    assert.equal(overlay(tree), null);
    tree.children[0].children[0].children[1].props.onClick();
    tree = hookHost.render(body);
    assert.equal(overlay(tree).props.tab, 'calls', 'reopening starts on «Вызывает» again');
  } finally {
    hookHost = null;
  }
});

test('the preview pane frames references the same way the page does', () => {
  const { CodePreview, tokenize, analyzeModule } = bundle.__bsl;
  const source = [
    'Процедура Первая()',   // 1
    '\tВторая();',           // 2
    '\tОбъект.Вторая();',    // 3
    'КонецПроцедуры',        // 4
    'Функция Вторая()',      // 5
    'КонецФункции',          // 6
  ].join('\n');
  const lines = tokenize(source);
  const { symbols } = analyzeModule(lines);
  const byName = new Map(symbols.map((symbol) => [symbol.name.toLowerCase(), symbol]));
  const followed = [];
  const hooks = {
    lookup: (name) => byName.get(name.toLowerCase()),
    go: (symbol) => followed.push(symbol.name),
  };
  const first = symbols[0];
  const pane = CodePreview({
    preview: { name: first.name, kind: first.kind, from: first.line, to: first.endLine, spans: lines.slice(first.line - 1, first.endLine) },
    hooks,
    t: (key) => key,
  });

  const rows = pane.children[1].children[0].children[0].children;
  const refs = rows
    .flatMap((row) => row.children[1].children)
    .filter((node) => typeof node === 'object' && node.props.className === 'bslh-ref');
  assert.equal(refs.length, 1, 'only the bare call is framed inside the preview');
  assert.equal(refs[0].props['data-ref'], 5, 'it points at Вторая');
  refs[0].props.onClick({ type: 'click', stopPropagation() {} });
  assert.deepEqual(followed, ['Вторая'], 'the click asks the dialog to follow the reference');
});

test('a call into another module is framed in violet and asks for its source', () => {
  const { CodePreview, tokenize, looksLikeExternalModule } = bundle.__bsl;

  assert.equal(looksLikeExternalModule('актив_Бюджетирование_ПоЗатратамНаВыпуск', new Set()), true);
  assert.equal(looksLikeExternalModule('Документ', new Set()), false, 'an object is not a module');
  assert.equal(looksLikeExternalModule('Запрос', new Set()), false);
  assert.equal(looksLikeExternalModule('Документ', new Set(['документ'])), true, 'a confirmed name is remembered');
  assert.equal(looksLikeExternalModule('', new Set()), false);

  const source = [
    'Процедура Тест()',                                                        // 1
    '\tактив_Бюджетирование_ПоЗатратамНаВыпуск.ПрименитьОтборКомпановщикаНастроек(Объект);', // 2
    '\tДокумент.Записать();',                                                  // 3
    'КонецПроцедуры',                                                          // 4
  ].join('\n');
  const lines = tokenize(source);
  const opened = [];
  const hooks = {
    lookup: () => undefined,
    go: () => {},
    external: {
      lookup: (module, method) => (looksLikeExternalModule(module, new Set()) ? { module, method } : undefined),
      open: (request) => opened.push(request),
    },
  };
  const pane = CodePreview({
    preview: { name: 'Тест', kind: 'procedure', from: 1, to: 4, spans: lines },
    hooks,
    t: (key) => key,
  });

  const rows = pane.children[1].children[0].children[0].children;
  const ext = rows
    .flatMap((row) => row.children[1].children)
    .filter((node) => typeof node === 'object' && node.props.className === 'bslh-ext');
  assert.equal(ext.length, 1, 'only the module call is framed this way');
  assert.equal(ext[0].props['data-ext'], 'актив_Бюджетирование_ПоЗатратамНаВыпуск.ПрименитьОтборКомпановщикаНастроек');
  assert.deepEqual(ext[0].children, ['актив_Бюджетирование_ПоЗатратамНаВыпуск', '.', 'ПрименитьОтборКомпановщикаНастроек']);

  ext[0].props.onClick({ type: 'click', stopPropagation() {} });
  assert.deepEqual(opened, [{
    module: 'актив_Бюджетирование_ПоЗатратамНаВыпуск',
    method: 'ПрименитьОтборКомпановщикаНастроек',
  }]);
});

test('clicking a module call reads it through the bridge and Esc closes the viewer', async () => {
  const seen = [];
  bundle.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    documentPreviews: { register: () => () => {} },
    slots: {
      inject: (_name, register) => {
        seen.push(register());
        return () => {};
      },
      register: (spec, component) => ({ spec, component }),
    },
  });
  const Body = seen[0].component;

  const asked = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        found: true,
        context: 'p0',
        module: 'Модуль_Тест',
        method: 'МетодМодуля',
        kind: 'function',
        line: 10,
        source: 'Функция МетодМодуля() Экспорт\n\tВозврат 1;\nКонецФункции',
      }),
    };
  };

  const listeners = [];
  globalThis.window.addEventListener = (type, fn) => listeners.push({ type, fn });
  globalThis.window.removeEventListener = (type, fn) => {
    const at = listeners.findIndex((entry) => entry.fn === fn);
    if (at >= 0) listeners.splice(at, 1);
  };

  hookHost = createHookHost();
  try {
    const props = {
      content: {
        kind: 'text',
        text: ['Процедура Тест()', '\tМодуль_Тест.МетодМодуля();', 'КонецПроцедуры'].join('\n'),
        eof: true,
      },
      wrap: false,
      scrollportRef: null,
      t: (key) => key,
    };
    const body = () => Body(props);
    const overlaysOf = (rendered) => rendered.children[2];

    let tree = hookHost.render(body);
    const frames = tree.children[1].children[0].children[0].children.flat()
      .filter((node) => node.props.className === 'bslh-routine');
    const ext = frames[0].children[1].children[1].children
      .find((node) => typeof node === 'object' && node.props.className === 'bslh-ext');
    assert.ok(ext !== undefined, 'the module call is framed');

    ext.props.onClick({ type: 'click', stopPropagation() {} });
    tree = hookHost.render(body);
    let viewer = overlaysOf(tree)[1];
    assert.equal(viewer.type, bundle.__bsl.ExternalDialog);
    assert.equal(viewer.props.phase, 'loading', 'it says so while the host reads');

    await new Promise((resolve) => setTimeout(resolve, 0));
    tree = hookHost.render(body);
    viewer = overlaysOf(tree)[1];
    assert.equal(viewer.props.phase, 'ready');
    assert.equal(viewer.props.entry.module, 'Модуль_Тест');
    assert.equal(viewer.props.entry.method, 'МетодМодуля');
    assert.match(asked[0], /\/api\/bsl-external\/method\?/);
    assert.match(asked[0], /module=%D0%9C%D0%BE%D0%B4%D1%83%D0%BB%D1%8C_%D0%A2%D0%B5%D1%81%D1%82/);

    const escape = listeners.find((entry) => entry.type === 'keydown');
    escape.fn({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    tree = hookHost.render(body);
    assert.equal(overlaysOf(tree)[1], null, 'Esc closes the viewer');
    assert.equal(listeners.length, 0, 'and the listener goes away with it');
  } finally {
    hookHost = null;
    globalThis.fetch = originalFetch;
  }
});

test('the dialog preview frames module calls too and stacks the viewer above it', async () => {
  const seen = [];
  bundle.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    documentPreviews: { register: () => () => {} },
    slots: {
      inject: (_name, register) => {
        seen.push(register());
        return () => {};
      },
      register: (spec, component) => ({ spec, component }),
    },
  });
  const Body = seen[0].component;

  const asked = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        found: true, module: 'Модуль_Тест', method: 'МетодМодуля', kind: 'function', line: 10,
        source: 'Функция МетодМодуля() Экспорт\nКонецФункции',
      }),
    };
  };

  hookHost = createHookHost();
  try {
    const props = {
      content: {
        kind: 'text',
        text: ['Процедура Тест()', '\tМодуль_Тест.МетодМодуля();', 'КонецПроцедуры'].join('\n'),
        eof: true,
      },
      wrap: false,
      scrollportRef: null,
      t: (key) => key,
    };
    const body = () => Body(props);
    const overlaysOf = (rendered) => rendered.children[2];

    let tree = hookHost.render(body);
    tree.children[0].children[0].children[1].props.onClick();   // open the navigation dialog
    tree = hookHost.render(body);
    const dialog = overlaysOf(tree)[0];
    assert.equal(dialog.type, bundle.__bsl.NavDialog);

    // The dialog's preview resolves a module call the same way the page does.
    const resolved = dialog.props.hooks.external.lookup('Модуль_Тест', 'МетодМодуля');
    assert.deepEqual(resolved, { module: 'Модуль_Тест', method: 'МетодМодуля' });
    assert.equal(dialog.props.hooks.external.lookup('Документ', 'Записать'), undefined);

    dialog.props.hooks.external.open(resolved);
    tree = hookHost.render(body);
    const overlays = overlaysOf(tree);
    assert.equal(overlays[0].type, bundle.__bsl.NavDialog, 'the picker stays mounted underneath');
    assert.equal(overlays[1].type, bundle.__bsl.ExternalDialog, 'the viewer stacks above it');

    await new Promise((resolve) => setTimeout(resolve, 0));
    tree = hookHost.render(body);
    assert.equal(overlaysOf(tree)[1].props.phase, 'ready');
    assert.match(asked[0], /module=%D0%9C%D0%BE%D0%B4%D1%83%D0%BB%D1%8C_%D0%A2%D0%B5%D1%81%D1%82/);
  } finally {
    hookHost = null;
    globalThis.fetch = originalFetch;
  }
});

test('the cross-module viewer shows loading, the source and the error', () => {
  const { ExternalDialog } = bundle.__bsl;
  const t = (key) => ({ external: 'Метод из cfsmcp2', externalLoading: 'loading', externalEmpty: 'empty', externalSource: 'src', close: 'Закрыть', cancel: 'Отмена' }[key] ?? key);
  const request = { module: 'актив_Бюджетирование_ПоЗатратамНаВыпуск', method: 'ПрименитьОтборКомпановщикаНастроек' };

  const loading = ExternalDialog({ request, phase: 'loading', entry: null, error: null, onClose: () => {}, t });
  const statusOf = (dialog) => dialog.children[0].children[1].children[0].children[0];
  assert.equal(statusOf(loading).props.className, 'bslh-status');
  assert.equal(statusOf(loading).children[0], 'loading');

  const failed = ExternalDialog({ request, phase: 'error', entry: null, error: 'MCP 404', onClose: () => {}, t });
  assert.equal(statusOf(failed).children[0], 'MCP 404', 'the reason is shown as it came');

  const ready = ExternalDialog({
    request,
    phase: 'ready',
    entry: { module: request.module, method: request.method, kind: 'function', line: 597, source: 'Функция ПрименитьОтборКомпановщикаНастроек() Экспорт\n\tВозврат 1;\nКонецФункции' },
    error: null,
    onClose: () => {},
    t,
  });
  const code = ready.children[0].children[1].children[0];
  assert.equal(code.props.preview.name, `${request.module}.${request.method}`);
  assert.equal(code.props.preview.kind, 'function');
  assert.equal(code.props.preview.from, 597, 'line numbers stay the module file’s');
  assert.equal(code.props.preview.to, 599);
  const firstRow = code.props.preview.spans[0];
  assert.equal(firstRow[0].t, 'kw', 'the fetched source is tokenized with the page palette');
});

test('the preview can draw «Назад» above the code it returns from', () => {
  const { CodePreview } = bundle.__bsl;
  const preview = { name: 'Тест', kind: 'procedure', from: 1, to: 2, spans: [[{ t: 'kw', s: 'Процедура' }], [{ t: 'kw', s: 'КонецПроцедуры' }]] };
  const withBack = CodePreview({ preview, hooks: { lookup: () => undefined, go: () => {} }, canBack: true, onBack: () => {}, t: (key) => key });
  const caption = withBack.children[0];
  assert.equal(caption.props.className, 'bslh-pane-caption');
  assert.equal(caption.children[0].type, bundle.__bsl.BackButton, 'the button is the first thing above the code');
  assert.equal(caption.children[0].props.canBack, true);
  assert.equal(caption.children[1].props.className, 'bslh-badge', 'the routine badge follows it');

  const withoutBack = CodePreview({ preview, hooks: { lookup: () => undefined, go: () => {} }, t: (key) => key });
  assert.equal(withoutBack.children[0].children[0].props.className, 'bslh-badge', 'no button where it is not wanted');
});

test('following a reference in the dialog moves the cursor, and its back returns', () => {
  const seen = [];
  bundle.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    documentPreviews: { register: () => () => {} },
    slots: {
      inject: (_name, register) => {
        seen.push(register());
        return () => {};
      },
      register: (spec, component) => ({ spec, component }),
    },
  });
  const Body = seen[0].component;

  hookHost = createHookHost();
  try {
    const props = {
      content: {
        kind: 'text',
        text: ['Процедура Первая()', '\tВторая();', 'КонецПроцедуры', '', 'Функция Вторая()', 'КонецФункции'].join('\n'),
        eof: true,
      },
      wrap: false,
      scrollportRef: null,
      t: (key) => key,
    };
    const body = () => Body(props);
    const overlay = (rendered) => {
      const slot = rendered.children[2];
      return Array.isArray(slot) ? (slot.find(Boolean) ?? null) : (slot ?? null);
    };

    let tree = hookHost.render(body);
    tree.children[0].children[0].children[1].props.onClick();   // open the dialog
    tree = hookHost.render(body);
    let dialog = overlay(tree);
    assert.equal(dialog.type, bundle.__bsl.NavDialog);
    // Follow a reference from the flat list, where a row index is observable.
    dialog.props.onTab('list');
    tree = hookHost.render(body);
    dialog = overlay(tree);
    assert.equal(dialog.props.preview.name, 'Первая');
    assert.equal(dialog.props.canBack, false, 'nothing followed yet');

    const target = dialog.props.hooks.lookup('Вторая');
    dialog.props.hooks.go(target);
    tree = hookHost.render(body);
    dialog = overlay(tree);
    assert.equal(dialog.props.preview.name, 'Вторая', 'the preview followed the reference');
    assert.equal(dialog.props.pane.props.activeIndex, 1, 'and the cursor on the left moved with it');
    assert.equal(dialog.props.canBack, true, 'the dialog can go back');

    dialog.props.onBack();
    tree = hookHost.render(body);
    dialog = overlay(tree);
    assert.equal(dialog.props.preview.name, 'Первая', 'back returns the previous preview');
    assert.equal(dialog.props.pane.props.activeIndex, 0, 'and the cursor goes back too');
    assert.equal(dialog.props.canBack, false);
  } finally {
    hookHost = null;
  }
});

test('find matches text, case and whole words the way an editor does', () => {
  const { findMatches, tokenize, marksByLine, lineText } = bundle.__bsl;
  const lines = tokenize([
    'Процедура Тест()',        // 1
    '\tПомощник();',            // 2
    '\tПомощник(); Помощник();', // 3
    '\tпомощник = 1;',          // 4
    'КонецПроцедуры',           // 5
  ].join('\n'));

  assert.equal(lineText(lines[1]), '\tПомощник();');
  const all = findMatches(lines, 'Помощник');
  assert.deepEqual(all.map((hit) => [hit.line, hit.start]), [[2, 1], [3, 1], [3, 13], [4, 1]], 'every occurrence, both on line 3');
  assert.equal(all.length, 4, 'case-insensitive by default, so the lower-case assignment matches too');
  assert.equal(all[0].text, 'Помощник');

  assert.equal(findMatches(lines, 'Помощник', { caseSensitive: true }).length, 3, 'the lower-case line drops out');
  assert.equal(findMatches(lines, 'помощник', { caseSensitive: true }).length, 1);

  assert.equal(findMatches(lines, '').length, 0, 'an empty query has no hits');
  assert.equal(findMatches(lines, 'НетТакого').length, 0);

  const word = findMatches(lines, 'Помощник', { wholeWord: true });
  assert.deepEqual(word.map((hit) => hit.line), [2, 3, 3, 4], 'all four are whole words');
  assert.equal(findMatches(lines, 'омощник', { wholeWord: true }).length, 0, 'a fragment inside a word is rejected');
  const marks = marksByLine(all, 1);
  assert.equal(marks.get(1), undefined, 'lines without hits have no marks');
  assert.deepEqual(marks.get(3).map((mark) => mark.current), [true, false], 'the hit under the cursor is the current one');
});

test('a hit is wrapped in <mark> without losing the token colour', () => {
  const { renderLine, tokenize, marksByLine, findMatches } = bundle.__bsl;
  const lines = tokenize('\tПомощник();');
  const hits = findMatches(lines, 'Помощник');
  const marks = marksByLine(hits, 0);
  const row = renderLine(lines[0], 1, undefined, marks.get(1));
  const text = row.children[1];
  const marksInRow = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.type === 'mark') marksInRow.push(node);
    walk(node.children);
  };
  walk(text.children);
  assert.equal(marksInRow.length, 1);
  assert.equal(marksInRow[0].children[0], 'Помощник');
  assert.equal(marksInRow[0].props.className, 'bslh-hit bslh-hit-cur', 'the current hit is the strong one');
  assert.equal(marksInRow[0].props['data-hit'], 'current');
});

test('Ctrl+F opens the bar, stepping wraps, Esc closes it', async () => {
  const seen = [];
  bundle.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    documentPreviews: { register: () => () => {} },
    slots: {
      inject: (_name, register) => {
        seen.push(register());
        return () => {};
      },
      register: (spec, component) => ({ spec, component }),
    },
  });
  const Body = seen[0].component;

  hookHost = createHookHost();
  try {
    const props = {
      content: {
        kind: 'text',
        text: ['Процедура Тест()', '\tПомощник();', '\tПомощник();', 'КонецПроцедуры'].join('\n'),
        eof: true,
      },
      wrap: false,
      scrollportRef: null,
      t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    };
    const body = () => Body(props);
    const bar = (rendered) => rendered.children[1];

    let tree = hookHost.render(body);
    assert.equal(bar(tree).type, 'div', 'no find bar before the shortcut');
    tree.props.onKeyDown({ ctrlKey: true, key: 'f', preventDefault() {} });
    tree = hookHost.render(body);
    assert.equal(bar(tree).type, bundle.__bsl.FindBar, 'Ctrl+F opens the bar');
    assert.equal(bar(tree).props.total, 0);
    assert.equal(bar(tree).props.query, '');

    bar(tree).props.onQuery('Помощник');
    tree = hookHost.render(body);
    assert.equal(bar(tree).props.total, 2, 'both calls are found');
    assert.equal(bar(tree).props.index, 0);

    bar(tree).props.onNext();
    tree = hookHost.render(body);
    assert.equal(bar(tree).props.index, 1);
    bar(tree).props.onNext();
    tree = hookHost.render(body);
    assert.equal(bar(tree).props.index, 0, 'stepping wraps to the first hit');
    bar(tree).props.onPrev();
    tree = hookHost.render(body);
    assert.equal(bar(tree).props.index, 1, 'and back to the last one');

    // The page marks the current hit.
    const scroll = tree.children[2];
    const code = scroll.children[0].children[0];
    const rows = [];
    const walk = (node) => {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node !== 'object') return;
      if (node.type === 'mark') rows.push(node);
      walk(node.children);
    };
    walk(code);
    assert.equal(rows.length, 2, 'both hits are marked in the page');
    assert.equal(rows.filter((mark) => mark.props['data-hit'] === 'current').length, 1, 'exactly one is current');

    bar(tree).props.onClose();
    tree = hookHost.render(body);
    assert.notEqual(bar(tree).type, bundle.__bsl.FindBar, 'closing hides the bar');
  } finally {
    hookHost = null;
  }
});

test('the find bar renders the counter, the switches and the hit list', () => {
  const { FindBar } = bundle.__bsl;
  const t = (key, params) => (params === undefined ? key : `${key}:${params.index}/${params.total}`);
  const bar = FindBar({
    inputRef: null,
    query: 'Помощник',
    index: 1,
    total: 3,
    caseSensitive: true,
    wholeWord: true,
    listOpen: true,
    matches: [
      { line: 2, start: 1, end: 9, text: 'Помощник', prefix: '\t', suffix: '();' },
      { line: 3, start: 1, end: 9, text: 'Помощник', prefix: '\t', suffix: '();' },
      { line: 9, start: 0, end: 8, text: 'Помощник', prefix: '', suffix: '()' },
    ],
    onQuery: () => {}, onPrev: () => {}, onNext: () => {}, onToggleCase: () => {},
    onToggleWord: () => {}, onToggleList: () => {}, onJump: () => {}, onClose: () => {},
    t,
  });
  const [icon, field, count, prev, next, caseButton, wordButton, listButton, close] = bar.children[0].children;
  assert.equal(icon.children[0], '⌕');
  assert.equal(field.type, 'input');
  assert.equal(field.props.value, 'Помощник');
  assert.equal(typeof field.props.onChange, 'function', 'a controlled field needs onChange, or React makes it read-only');
  assert.equal(count.children[0], 'findCount:2/3', 'the counter says where the reader is');
  assert.equal(prev.children[0], '↑');
  assert.equal(next.children[0], '↓');
  assert.equal(caseButton.props['data-active'], 'true');
  assert.equal(caseButton.children[0], 'Aa');
  assert.equal(wordButton.props['data-active'], 'true');
  assert.equal(listButton.props['data-active'], 'true');
  assert.equal(close.children[0], '×');
  assert.equal(close.props['aria-label'], 'findClose');

  const rows = bar.children[1].children;
  assert.equal(rows.length, 3);
  assert.equal(rows[1].props['data-active'], 'true', 'the current hit is highlighted in the list');
  const snippet = rows[0].children[1];
  assert.equal(snippet.children[0].children[0], '\t', 'the text before the hit');
  assert.equal(snippet.children[1].children[0], 'Помощник', 'the hit itself');
  assert.equal(snippet.children[2].children[0], '();', 'and the text after it');
});

test('the dialog filter finds routines by part of their name', async () => {
  const seen = [];
  bundle.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    documentPreviews: { register: () => () => {} },
    slots: {
      inject: (_name, register) => {
        seen.push(register());
        return () => {};
      },
      register: (spec, component) => ({ spec, component }),
    },
  });
  const Body = seen[0].component;

  hookHost = createHookHost();
  try {
    const props = {
      content: {
        kind: 'text',
        text: ['Функция ДатьСуммуВсего()', 'КонецФункции', '', 'Функция ДатьТаблицу()', 'КонецФункции'].join('\n'),
        eof: true,
      },
      wrap: false,
      scrollportRef: null,
      t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    };
    const body = () => Body(props);
    const dialogOf = (rendered) => {
      const slot = rendered.children[rendered.children.length - 1];
      return Array.isArray(slot) ? (slot.find(Boolean) ?? null) : (slot ?? null);
    };

    let tree = hookHost.render(body);
    tree.children[0].children[0].children[1].props.onClick();
    tree = hookHost.render(body);
    let dialog = dialogOf(tree);
    assert.equal(dialog.type, bundle.__bsl.NavDialog);
    assert.equal(dialog.props.filter.value, '', 'the filter starts empty');

    dialog.props.filter.onChange('Дать');
    tree = hookHost.render(body);
    dialog = dialogOf(tree);
    assert.equal(dialog.props.filter.count, 2, 'both «Дать…» routines match');
    assert.equal(dialog.props.pane.props.key, 'hits', 'the pane shows the matching routines');
    assert.equal(dialog.props.pane.props.symbols.length, 2);
    assert.equal(dialog.props.preview.name, 'ДатьСуммуВсего', 'the preview follows the first match');

    dialog.props.filter.onChange('Таблиц');
    tree = hookHost.render(body);
    dialog = dialogOf(tree);
    assert.equal(dialog.props.filter.count, 1);
    assert.equal(dialog.props.preview.name, 'ДатьТаблицу');

    dialog.props.filter.onChange('НетТакого');
    tree = hookHost.render(body);
    dialog = dialogOf(tree);
    assert.equal(dialog.props.filter.count, 0);
    assert.equal(dialog.props.pane.children[0], 'filterNone');
    assert.equal(dialog.props.goDisabled, true, '«Перейти» has nothing to jump to');

    dialog.props.filter.onClear();
    tree = hookHost.render(body);
    dialog = dialogOf(tree);
    assert.equal(dialog.props.filter.value, '');
    assert.equal(dialog.props.pane.props.key, 'tree', 'clearing returns to the tab’s pane');
  } finally {
    hookHost = null;
  }
});

test('a module is matched to the dump regardless of letter case', async () => {
  const { pickMethod } = await import('../bridge.js');

  const hits = [
    { name: 'ДатьСуммуВсегоПоНесколькимСФ', path: 'ОбщиеМодули.Актив_Общий.Методы.Module.ДатьСуммуВсегоПоНесколькимСФ', parent_path: 'ОбщиеМодули.Актив_Общий', kind: 'Function' },
    { name: 'ДатьСуммуВсегоПоНесколькимСФ', path: 'Документы.СчетФактура.Методы.Form.ДатьСуммуВсегоПоНесколькимСФ', parent_path: 'Документы.СчетФактура.Формы.ФормаДокумента', kind: 'Function' },
    { name: 'ДругоеИмя', path: 'ОбщиеМодули.Актив_Общий.Методы.Module.ДругоеИмя', parent_path: 'ОбщиеМодули.Актив_Общий' },
  ];

  const found = pickMethod(hits, 'актив_Общий', 'ДатьСуммуВсегоПоНесколькимСФ');
  assert.equal(found?.parent_path, 'ОбщиеМодули.Актив_Общий', 'the spelling of the code finds the dump’s module');
  assert.equal(pickMethod(hits, 'АКТИВ_ОБЩИЙ', 'ДатьСуммуВсегоПоНесколькимСФ')?.parent_path, 'ОбщиеМодули.Актив_Общий');
  assert.equal(pickMethod(hits, 'актив_Общий', 'другоеимя')?.name, 'ДругоеИмя', 'the routine name is matched the same way');
  assert.equal(pickMethod(hits, 'актив_Другой', 'ДатьСуммуВсегоПоНесколькимСФ'), null, 'a method of the right name in another module is not taken');
  assert.equal(pickMethod(hits, 'актив_Общий', 'НетТакого'), null);
  assert.equal(pickMethod([], 'актив_Общий', 'ДатьСуммуВсегоПоНесколькимСФ'), null);
  assert.equal(pickMethod(null, 'актив_Общий', 'x'), null, 'no hits at all is not a crash');
});

test('the cfsmcp2 endpoint can be a port of your own', async () => {
  const { readConfig } = await import('../index.js');

  assert.deepEqual(readConfig(undefined), { mcpUrl: 'http://127.0.0.1:8559/mcp/', context: 'p0' }, 'defaults are unchanged');
  assert.equal(readConfig({ mcpPort: 8600 }).mcpUrl, 'http://127.0.0.1:8600/mcp/', 'a number or a string');
  assert.equal(readConfig({ mcpPort: '8600' }).mcpUrl, 'http://127.0.0.1:8600/mcp/');
  assert.equal(readConfig({ mcpHost: '10.0.0.5', mcpPort: 8600 }).mcpUrl, 'http://10.0.0.5:8600/mcp/', 'another host too');
  assert.equal(readConfig({ mcpPort: '10.0.0.5:8600' }).mcpUrl, 'http://10.0.0.5:8600/mcp/', 'host:port shorthand');
  assert.equal(readConfig({ mcpUrl: 'http://localhost:9000/mcp' }).mcpUrl, 'http://localhost:9000/mcp/', 'a URL is normalised');
  assert.equal(readConfig({ mcpUrl: 'localhost:9000' }).mcpUrl, 'http://localhost:9000/mcp/', 'even without a scheme');
  assert.equal(readConfig({ mcpUrl: 'http://localhost:9000/mcp/' }).mcpUrl, 'http://localhost:9000/mcp/');
  assert.equal(readConfig({ mcpPort: 'abc' }).mcpUrl, 'http://127.0.0.1:8559/mcp/', 'a broken port falls back to the default');
  assert.equal(readConfig({ mcpPort: 70000 }).mcpUrl, 'http://127.0.0.1:8559/mcp/', 'a port out of range too');
  assert.equal(readConfig({ context: 'k0', mcpPort: 8600 }).context, 'k0', 'the context stays independent');
});

test('the palette is the Configurator standard scheme, hard-coded', () => {
  const { TOKEN_STYLE, CONFIGURATOR, CSS } = bundle.__bsl;

  // Configuration → Параметры → Модули → Редактирование, defaults.
  assert.deepEqual(CONFIGURATOR, {
    keyword: '#ff0000',
    constant: '#000000',
    identifier: '#0000ff',
    operator: '#ff0000',
    comment: '#008000',
    preprocessor: '#963200',
    other: '#000000',
    background: '#ffffff',
  });

  assert.equal(TOKEN_STYLE.kw.color, '#ff0000', 'keywords are red');
  assert.equal(TOKEN_STYLE.con.color, '#ff0000', 'reserved words read as keywords');
  assert.equal(TOKEN_STYLE.id.color, '#0000ff', 'every name is an identifier');
  assert.equal(TOKEN_STYLE.type.color, '#0000ff', 'types are identifiers too');
  assert.equal(TOKEN_STYLE.fn.color, '#0000ff', 'calls and members are identifiers');
  assert.equal(TOKEN_STYLE.str.color, '#000000', 'string constants are plain black');
  assert.equal(TOKEN_STYLE.num.color, '#000000', 'numeric and date constants are plain black');
  assert.equal(TOKEN_STYLE.com.color, '#008000', 'comments are green');
  assert.equal(TOKEN_STYLE.ann.color, '#963200', 'preprocessor directives are brown');
  assert.equal(TOKEN_STYLE.pun.color, '#ff0000', 'operators are red');

  // A palette that followed the app theme would show a custom property here.
  for (const [name, style] of Object.entries(TOKEN_STYLE)) {
    assert.doesNotMatch(style.color, /var\(/u, `${name} must not follow the theme`);
  }
  assert.doesNotMatch(CSS, /var\(--(?:shiki|dsw-alias)/u, 'no colour may come from a theme token');
});

test('the preview stays a light page even in a dark application', () => {
  const { CSS } = bundle.__bsl;
  assert.match(CSS, /color-scheme:light/u, 'native scrollbars and selection stay light');
  assert.match(CSS, /background:#ffffff/u, 'the page is white');
  assert.match(CSS, /color:#000000/u, 'the base text is black');
  // The chrome is light too: a dark toolbar above a white page would look broken.
  assert.match(CSS, /background:#f4f4f4/u);
  assert.match(CSS, /border-bottom:1px solid #dbdbdb/u);
});

test('apply registers a preview implementation and its keyed body', () => {
  const seen = { locale: [], previews: [], slots: [] };
  const effects = [];
  const ctx = {
    effect(fn) {
      effects.push(fn);
      return fn();
    },
    locale: {
      register(namespace, dicts) {
        seen.locale.push({ namespace, dicts });
        return () => {};
      },
      bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    },
    documentPreviews: {
      register(definition) {
        seen.previews.push(definition);
        return () => {};
      },
    },
    slots: {
      inject(name, register) {
        seen.slots.push({ name, registration: register() });
        return () => {};
      },
      register(spec, component) {
        return { spec, component };
      },
    },
  };

  bundle.apply(ctx);

  assert.ok(bundle.inject.includes('documentPreviews'), 'the preview registry is a required service');
  assert.ok(bundle.inject.includes('slots'));
  assert.equal(seen.locale.length, 1);
  const [{ namespace, dicts }] = seen.locale;
  assert.equal(namespace, 'bslHighlight');
  for (const locale of ['en', 'zh', 'ru']) {
    assert.deepEqual(Object.keys(dicts[locale]).sort(), Object.keys(dicts.en).sort(), `${locale} keys`);
  }

  assert.equal(seen.previews.length, 1);
  const [definition] = seen.previews;
  assert.deepEqual(definition.extensions, ['bsl', '1c']);
  assert.equal(definition.loading, 'text-pages');
  assert.equal(definition.wrap, true);
  assert.equal(definition.priority, undefined, 'the extension band outranks builtin renderers');
  assert.equal(definition.title(), 'title');

  const body = seen.slots.find((entry) => entry.name === 'sidebar.right.tab.document');
  assert.ok(body !== undefined, 'the body registers into the keyed document slot');
  assert.equal(body.registration.spec.key, definition.id);
  assert.equal(body.registration.spec.locale, 'bslHighlight');
  assert.equal(typeof body.registration.component, 'function');
});

test('the body renders a code-preview pane the sidebar can size', () => {
  const Body = (() => {
    const seen = [];
    bundle.apply({
      effect: (fn) => fn(),
      locale: { register: () => () => {}, bind: () => (key) => key },
      documentPreviews: { register: () => () => {} },
      slots: {
        inject: (_name, register) => {
          seen.push(register());
          return () => {};
        },
        register: (spec, component) => ({ spec, component }),
      },
    });
    return seen[0].component;
  })();

  const tree = Body({
    content: { kind: 'text', text: 'Процедура Тест()\nКонецПроцедуры', eof: true },
    wrap: true,
    scrollportRef: () => {},
    t: (key) => key,
  });

  assert.equal(tree.props.className, 'bslh-root');
  assert.equal(tree.props['data-code-preview'], true, 'the pane layout rule keys on this attribute');
  assert.equal(tree.props['data-wrap'], 'true');
  assert.equal(tree.props.style['--bslh-gutter'], '1ch');

  const [bar, scroll] = tree.children;
  assert.equal(bar.props.className, 'bslh-bar');
  const heading = bar.children[0];
  const backButton = heading.children[0];
  assert.equal(backButton.type, bundle.__bsl.BackButton, '«Назад» opens the top-left corner');
  assert.equal(backButton.props.canBack, false, 'nothing to go back to yet');
  const navButton = heading.children[1];
  assert.equal(typeof navButton.props.ref, 'object', 'the nav button is the focus anchor');
  assert.equal(navButton.props['data-bsl-nav'], true, 'one button replaces the list and tree buttons');
  assert.equal(navButton.props['aria-expanded'], 'false');
  assert.equal(heading.children[2].props.className, 'bslh-lang', 'the nav button stands right after «Назад»');
  const actions = bar.children[1];
  const [findButton, copyButton] = actions.children;
  assert.equal(actions.children.length, 2, 'the toolbar holds find and copy');
  assert.equal(findButton.props['data-bsl-find'], true, 'the find button opens the bar');
  assert.equal(findButton.props['aria-expanded'], 'false');
  assert.equal(copyButton.props.className, 'bslh-copy');
  assert.equal(scroll.props.className, 'bslh-scroll');
  assert.equal(typeof scroll.props.ref, 'function', 'the body owns the pane scrollport');

  const code = scroll.children[0];
  assert.equal(code.type, 'pre');
  // The page is a list of blocks: this module is one routine, so one frame.
  const blocks = code.children[0].children;
  assert.equal(blocks.length, 1);
  const frame = blocks[0];
  assert.equal(frame.props.className, 'bslh-routine');
  assert.equal(frame.props['data-routine'], 1, 'the frame is keyed by the declaration line');
  assert.equal(frame.props['data-current'], undefined, 'no routine is current yet');

  const lines = frame.children;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].props['data-textpreview-line'], 1, 'the owner scrolls to this anchor');
  assert.deepEqual(lines[0].children[0].children, ['1']);
  const runs = lines[0].children[1].children;
  assert.equal(runs[0].type, 'span');
  assert.equal(runs[0].props.style.color, '#ff0000');
});

test('a bytes payload renders nothing rather than a broken pane', () => {
  assert.equal(bundle.__bsl.EXTENSIONS.includes('bsl'), true);
});
