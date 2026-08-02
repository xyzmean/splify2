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

return view.extend({
	load: function () { return fetchBuildId(); },
	render: function (buildId) {
		var v = '?v=' + (buildId || Date.now());

		// Мост к LuCI: bundle читает window.luci_rpc и window.ui.
		window.luci_rpc = rpc;
		window.ui = ui;

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

		var container = E('div', { id: 'splify-root', 'class': 'splify-react-root' });

		// Модуль переиспользуется в пределах документа: каждый уникальный URL — это
		// отдельный ES-модуль, который браузер держит до конца жизни документа, так
		// что загрузка с новым ?v= на каждый визит утекала бы целым бандлом.
		//
		// Но переиспользовать его при СМЕНЕ версии нельзя: LuCI ходит между страницами
		// без перезагрузки документа, поэтому после обновления пакета интерфейс
		// продолжал показывать прежний бандл — выглядело это как "на роутере всё так
		// же". Утечка одного старого модуля при смене версии — цена, которую платят
		// раз на обновление, а не на визит.
		if (window.__splifyMount && window.__splifyBuildId === buildId) {
			window.__splifyMount(container);
		} else {
			window.__splifyBuildId = buildId;
			var id = 'splify2-app-js-' + (buildId || 'dev');
			if (!document.getElementById(id)) {
				var script = document.createElement('script');
				script.id = id;
				script.src = L.resource('splify2/splify-index.js') + v;
				script.type = 'module';
				document.head.appendChild(script);
			} else if (window.__splifyMount) {
				window.__splifyMount(container);
			}
		}

		return container;
	},
	handleSave: null, handleSaveApply: null, handleReset: null
});
