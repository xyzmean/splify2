'use strict';
'require view';
'require rpc';
'require ui';

// Загрузчик, который не должен меняться между релизами. LuCI отдаёт этот файл с
// ?v=<ревизия luci-base>, то есть браузер держит его в кеше очень долго — именно так
// в splify 1 выживали устаревшие интерфейсы после обновлений и перезагрузок. Поэтому
// версия бандла не вписана здесь, а читается на каждой загрузке страницы из
// build-id.txt запросом с cache:'no-store' (десяток байт мимо кеша).

function fetchBuildId() {
	return fetch(L.resource('splify2/build-id.txt'), { cache: 'no-store' })
		.then(function (r) { return r.ok ? r.text() : ''; })
		.then(function (t) { return (t || '').trim(); })
		.catch(function () { return ''; });
}

// Номер прошлой сборки. Нужен ровно для одного: начать грузить бандл, НЕ ДОЖИДАЯСЬ ответа
// build-id.txt.
//
// Замерено на роутере: сам файл — десяток байт, но запрос к нему стоит около 225 мс, и всё
// это время цепочка стоит: загрузчик → build-id.txt → бандл → его общий чанк. Полторы секунды
// до первой строки нашего кода, из которых почти половина — ожидание двух запросов подряд.
//
// Поэтому: если номер прошлой сборки известен, бандл уходит в загрузку сразу, а build-id.txt
// проверяется параллельно. Совпало (обычный случай) — мы сэкономили запрос. Не совпало (пакет
// обновили) — грузим правильную сборку следом, как и раньше; цену платят один раз на
// обновление, а не на каждое открытие.
var LAST_ID = 'splify2:build-id';
function rememberedId() {
	try { return window.localStorage.getItem(LAST_ID) || ''; } catch (e) { return ''; }
}
function rememberId(id) {
	try { if (id) window.localStorage.setItem(LAST_ID, id); } catch (e) { /* приватное окно */ }
}

// Подключить сборку: стили и модуль. Оба по одному номеру — расхождение означало бы
// оформление от одной сборки и разметку от другой.
function injectBuild(buildId) {
	var v = '?v=' + (buildId || Date.now());

	var cssId = 'splify2-app-css-' + (buildId || 'dev');
	if (!document.getElementById(cssId)) {
		var old = document.querySelector('link[id^="splify2-app-css"]');
		if (old) old.remove();
		var link = document.createElement('link');
		link.id = cssId;
		link.rel = 'stylesheet';
		link.href = L.resource('splify2/splify-index.css') + v;
		document.head.appendChild(link);
	}

	// Общий чанк — заранее и параллельно. Его находит только разбор splify-index.js, то есть
	// ещё через один заход в сеть (замерено: +184 мс); modulepreload убирает эту ступеньку,
	// ничего не исполняя.
	var preId = 'splify2-app-pre-' + (buildId || 'dev');
	if (!document.getElementById(preId)) {
		var pre = document.createElement('link');
		pre.id = preId;
		pre.rel = 'modulepreload';
		pre.href = L.resource('splify2/splify-x.js') + v;
		document.head.appendChild(pre);
	}

	var id = 'splify2-app-js-' + (buildId || 'dev');
	if (!document.getElementById(id)) {
		var script = document.createElement('script');
		script.id = id;
		script.src = L.resource('splify2/splify-index.js') + v;
		script.type = 'module';
		// Второй пояс к тому, который держит сам бандл. Модуль стартует раньше, чем LuCI
		// вставит контейнер, и монтируется, когда тот появится; но если бандл догрузился
		// ПОСЛЕ того, как render() уже отработал, звать его было некому — и раздел
		// открывался пустым экраном. Теперь зовём отсюда, по факту загрузки.
		script.onload = function () {
			var el = document.getElementById('splify-root');
			if (el && window.__splifyMount) window.__splifyMount(el);
		};
		document.head.appendChild(script);
		return true;
	}
	return false;
}

// Ранний старт. На уровне модуля — раньше этого мы ничего сделать не можем: этот файл LuCI
// исполняет сразу, как только человек открыл раздел.
//
// Мост к ubus отдаётся ЗДЕСЬ ЖЕ, до старта бандла, а не только в render(): бандл теперь может
// исполниться раньше render(), и без моста он видел бы «ubus недоступен». В render() он
// выставляется ещё раз — там он нужен на каждом заходе, а этот файл исполняется однажды.
(function () {
    window.luci_rpc = rpc;
    window.ui = ui;
	var id = rememberedId();
	if (!id || window.__splifyBuildId) return;
	window.__splifyBuildId = id;
	injectBuild(id);
})();

return view.extend({
	load: function () { return fetchBuildId(); },
	render: function (buildId) {
		// Мост к LuCI: bundle читает window.luci_rpc и window.ui.
		window.luci_rpc = rpc;
		window.ui = ui;

		// Таймаут ubus-вызовов. У LuCI по умолчанию 20 секунд, а steer_install
		// скачивает пакет с GitHub (до 60 секунд по своему таймауту), list_fetch —
		// списки у издателя. XHR обрывался ПЕРВЫМ, интерфейс честно показывал
		// «сбой» — а установка при этом доделывалась в фоне и завершалась успехом.
		// Хуже сообщения об ошибке только ложное: после него переустанавливают
		// то, что уже стоит. 120 секунд покрывают оба долгих вызова с запасом;
		// выставленное администратором значение больше нашего не трогаем.
		if (!(Number(L.env.rpctimeout) >= 120)) L.env.rpctimeout = 120;

		var container = E('div', { id: 'splify-root', 'class': 'splify-react-root' });

		// Модуль переиспользуется в пределах документа: каждый уникальный URL — это
		// отдельный ES-модуль, который браузер держит до конца жизни документа, так
		// что загрузка с новым ?v= на каждый визит утекала бы целым бандлом.
		//
		// Но переиспользовать его при СМЕНЕ версии нельзя: LuCI ходит между страницами
		// без перезагрузки документа, поэтому после обновления пакета интерфейс
		// продолжал показывать прежний бандл — выглядело это как «на роутере всё так
		// же». Утечка одного старого модуля при смене версии — цена, которую платят
		// раз на обновление, а не на визит.
		//
		// Сюда же приходит расплата за ранний старт: если он взял номер прошлой сборки,
		// а build-id.txt назвал другой, правильную сборку грузим теперь.
		if (buildId && buildId !== window.__splifyBuildId) {
			window.__splifyBuildId = buildId;
			injectBuild(buildId);
		} else if (!window.__splifyBuildId) {
			window.__splifyBuildId = buildId;
			injectBuild(buildId);
		}
		rememberId(buildId);

		// Модуль мог ещё не догрузиться — тогда он смонтируется сам, найдя контейнер в
		// дереве (см. main.tsx). Если уже готов, монтируем в свежий контейнер здесь.
		if (window.__splifyMount) window.__splifyMount(container);

		return container;
	},
	handleSave: null, handleSaveApply: null, handleReset: null
});
