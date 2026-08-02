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

		if (!document.getElementById('splify2-app-css')) {
			var link = document.createElement('link');
			link.id = 'splify2-app-css';
			link.rel = 'stylesheet';
			link.href = L.resource('splify2/splify-index.css') + v;
			document.head.appendChild(link);
		}

		var container = E('div', { id: 'splify-root', 'class': 'splify-react-root' });

		// Модуль загружается ОДИН раз на документ: каждый уникальный URL — это
		// отдельный ES-модуль, который браузер держит до конца жизни документа, так
		// что повторная загрузка с ?v= утекала бы целым бандлом на каждый визит.
		if (window.__splifyMount) {
			window.__splifyMount(container);
		} else if (!document.getElementById('splify2-app-js')) {
			var script = document.createElement('script');
			script.id = 'splify2-app-js';
			script.src = L.resource('splify2/splify-index.js') + v;
			script.type = 'module';
			document.head.appendChild(script);
		}

		return container;
	},
	handleSave: null, handleSaveApply: null, handleReset: null
});
