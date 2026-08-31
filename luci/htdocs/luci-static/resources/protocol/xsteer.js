'use strict';
'require uci';
'require ui';
'require form';
'require network';
'require rpc';

/* Протокол xsteer в LuCI: та же страница, что у WireGuard, и по той же причине.
 *
 * Человек, настраивающий туннель через веб-интерфейс, ждёт интерфейса, а не файла: зону
 * firewall, адрес, MTU, «Сохранить и применить». Всё это уже умеет netifd, и наша задача —
 * описать ему поля. Сам туннель поднимает /lib/netifd/proto/xsteer.sh, который собирает из
 * этих полей конфигурацию в стиле wg и запускает движок.
 *
 * ПОЧЕМУ ПИРЫ ОТДЕЛЬНЫМИ СЕКЦИЯМИ. Так сделано у WireGuard (`config wireguard_<интерфейс>`),
 * и повторять это соглашение важнее, чем придумать своё: человек, который однажды настраивал
 * wg через LuCI, не должен изучать второй способ ради того же смысла.
 *
 * У ПИРА РОВНО ОДНА СЕКЦИЯ [Peer] — ХАБ. Это не ограничение интерфейса, а свойство звезды: сети
 * других пиров задаются их префиксами в AllowedIPs этого пира, и трафик к ним идёт через хаб.
 * Движок такую конфигурацию проверяет и отвергает лишнее с внятной строкой, поэтому здесь
 * достаточно сказать это в подсказке.
 */

/* Кнопки «сгенерировать ключ» здесь НЕТ намеренно. Она требовала бы своей точки в rpcd и
 * права на неё, то есть ещё одного места, где приватный ключ проходит через веб-интерфейс.
 * Ключ делается одной командой на самом роутере — `steer xsteer-key`, — и так он не покидает
 * консоль. Объявить вызов и не реализовать его было бы хуже всего: страница обещала бы то,
 * чего нет. */

/* Разбор конфигурации в стиле wg — тот же формат, что печатает server/xs_install.sh на хабе и
 * что читает движок из /etc/steer/xsteer/*.conf.
 *
 * ПОЧЕМУ РАЗБОР ПОВТОРЁН ЗДЕСЬ, а не сделан вызовом движка. Страница обязана работать до того,
 * как что-либо записано: человек вставляет текст, и ошибку в нём надо назвать сразу, в том же
 * окне. Отправить текст на роутер и ждать ответа значило бы завести для этого точку rpcd,
 * которая принимает ПРИВАТНЫЙ КЛЮЧ, — второе место, где ключ проходит через веб-интерфейс.
 *
 * Цена повторения названа прямо: два разбора одного формата могут разойтись. Поэтому здесь
 * НЕТ своих правил — только те же, что у движка, и отказ теми же словами. Ключи, которых
 * движок не делает, отвергаются, а не отбрасываются молча.
 *
 * ОТКАЗ И ПРЕДУПРЕЖДЕНИЕ — РАЗНЫЕ ВЕЩИ, и `DNS` показал разницу. Раньше он отвергал файл
 * целиком, и это ломало главное свойство формата: конфигурация носится между роутером и
 * десктопом, а десктопный клиент DNS применяет. Файл, принятый одной стороной и отвергнутый
 * другой, означает, что «настроено» зависит от того, куда его положили. Движок теперь такой
 * ключ ПРИНИМАЕТ и говорит вслух, что не применяет его (именами на роутере распоряжается
 * dnsmasq); страница обязана вести себя так же — иначе она снова разойдётся с движком, только
 * в другую сторону.
 */
var REFUSED = {
	table: _('таблицей маршрутизации владеет сам движок'),
	fwmark: _('метками владеет движок (registry_assign)'),
	preup: _('команд из конфигурации steer не исполняет'),
	postup: _('команд из конфигурации steer не исполняет'),
	predown: _('команд из конфигурации steer не исполняет'),
	postdown: _('команд из конфигурации steer не исполняет'),
	saveconfig: _('steer конфигурацию не перезаписывает'),
	presharedkey: _('общего секрета в xsteer нет: рукопожатие Noise IK его не использует'),
	listenport: _('ListenPort бывает только у хаба — пир начинает соединение сам')
};

/* Ключи, которые ПРИНИМАЮТСЯ, но поведения за ними здесь нет. Молча проглотить их нельзя —
 * человек, написавший DNS, ждёт, что запросы пойдут в туннель, — но и отвергать файл из-за них
 * нельзя (см. выше). Поэтому они попадают в предупреждения, а конфигурация применяется. */
var WARNED = {
	dns: _('DNS из конфигурации на роутере не применяется: именами распоряжается dnsmasq. Заведите доменный канал, если запросы должны идти в туннель.')
};

/* Ссылка xs:// → текст конфигурации. РАЗБИРАЕТ ЕЁ ДВИЖОК, а не эта страница, и это не лень.
 * Формат ссылки описан один раз (steer, src/ext/xslink.c) и сверяется побайтово с половиной на Go;
 * свой разбор здесь был бы третьей реализацией одного формата — и первой, у которой нет стенда.
 * Разбор файла в стиле wg страница делает сама по другой причине: он был здесь до того, как у
 * движка появился способ ответить, и он не требует запроса к роутеру для показа ошибки в поле.
 * Ссылка же приходит от человека целиком и проверяется целиком — один запрос на нажатие. */
var callXsteerLink = rpc.declare({
	object: 'splify2',
	method: 'xsteer_link',
	params: [ 'link' ],
	expect: { }
});

function isB64Key(v) {
	return typeof v == 'string' && v.match(/^[A-Za-z0-9+\/]{43}=$/) != null;
}

function parseXsteerConfig(data) {
	/* Разделители строк — и \n, и \r\n, и одинокий \r: конфигурацию приносят файлом из Windows,
	 * из буфера обмена и перетаскиванием, и все три способа дают разные концы строк. */
	var lines = String(data).split(/\r\n|\r|\n/);
	var section = null, iface = {}, peers = [], cur = null, warnings = [];

	for (var i = 0; i < lines.length; i++) {
		/* Комментарии и `#`, и `;` — как у движка. БЕЗ якоря `$`: в регулярных выражениях JS
		 * точка не пересекает `\r`, поэтому `[#;].*$` на строке «# что-то\r» не совпадал вовсе
		 * и комментарий доезжал до разбора как ошибка. Проверено стендом. */
		var line = lines[i].replace(/[#;].*/, '').trim();
		if (!line.length)
			continue;
		var m = line.match(/^\[(\w+)\]$/);
		if (m) {
			section = m[1].toLowerCase();
			if (section == 'peer') {
				cur = {};
				peers.push(cur);
			} else if (section == 'interface') {
				cur = iface;
			} else {
				return _('Неизвестная секция [%s] в строке %d').format(m[1], i + 1);
			}
			continue;
		}
		var kv = line.match(/^(\w+)\s*=\s*(.*)$/);
		if (!kv)
			return _('Строка %d не разбирается: %s').format(i + 1, line);
		if (!section)
			return _('Строка %d стоит до всякой секции').format(i + 1);
		var key = kv[1].toLowerCase(), val = kv[2].trim();
		if (REFUSED[key])
			return _('Ключ %s (строка %d) не поддерживается: %s').format(kv[1], i + 1, REFUSED[key]);
		if (WARNED[key] && warnings.indexOf(WARNED[key]) < 0)
			warnings.push(WARNED[key]);
		if (val.length)
			cur[key] = val;
	}

	if (!isB64Key(iface.privatekey))
		return _('PrivateKey отсутствует или не 44 символа base64');
	if (!iface.address)
		return _('Address отсутствует: без адреса в туннеле хаб не узнаёт пир');
	/* Ровно один пир — это не ограничение страницы, а свойство звезды: сети остальных пиров
	 * задаются в AllowedIPs хаба, и трафик к ним идёт через него. */
	if (peers.length != 1)
		return _('Ожидается ровно одна секция [Peer] — хаб. Найдено: %d').format(peers.length);
	var p = peers[0];
	if (!isB64Key(p.publickey))
		return _('PublicKey хаба отсутствует или не 44 символа base64');
	if (!p.endpoint)
		return _('Endpoint отсутствует: пир начинает соединение сам, и адрес хаба обязателен');
	/* Только литерал IPv4 — то же правило, что у движка, и по той же причине: разрешение имени
	 * пошло бы через DNS, который сам может быть направлен в этот же туннель. */
	var ep = String(p.endpoint).match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
	if (!ep)
		return _('Endpoint должен быть адресом IPv4 и портом, например 203.0.113.7:443 (имя не подойдёт: его разрешение может уйти в этот же туннель)');
	if (+ep[2] < 1 || +ep[2] > 65535)
		return _('Порт хаба вне диапазона');
	if (!p.allowedips)
		return _('AllowedIPs отсутствует: непонятно, что заворачивать в туннель');

	return {
		private_key: iface.privatekey,
		addresses: String(iface.address).split(/[,\s]+/).filter(function(x) { return x.length; }),
		sni: iface.sni || '',
		mtu: iface.mtu || '',
		public_key: p.publickey,
		endpoint_host: ep[1],
		endpoint_port: ep[2],
		allowed_ips: String(p.allowedips).split(/[,\s]+/).filter(function(x) { return x.length; }),
		persistent_keepalive: p.persistentkeepalive || '',
		warnings: warnings
	};
}

network.registerPatternVirtual(/^xs-.+$/);
network.registerErrorCode('NO_PRIVATE_KEY', _('Приватный ключ не задан'));
network.registerErrorCode('INVALID_CONFIG', _('Движок отверг настройки: смотрите системный журнал'));
/* Коды устройства. Без записи здесь LuCI показывает человеку сырой код вместо причины, а
   причина у обоих одна и та же по смыслу: устройства нет, поднимать нечего. */
network.registerErrorCode('DEVICE_NAME_TOO_LONG', _('Имя устройства длиннее 15 символов (предел ядра)'));
network.registerErrorCode('DEVICE_SETUP_FAILED', _('Устройство туннеля не создалось: смотрите системный журнал'));

return network.registerProtocol('xsteer', {
	getI18n: function() {
		return _('xsteer (звезда поверх поддельного TCP)');
	},

	getIfname: function() {
		return this._ubus('l3_device') || 'xs-%s'.format(this.sid);
	},

	/* Имя метода — getPackageName, а не getOpkgPackage: в LuCI этой версии (сверено с
	 * работающим amneziawg.js на самом роутере) спрашивают именно его, и старое имя молча
	 * ничего не вернуло бы — кнопка «установить расширения протокола» осталась бы без пакета.
	 *
	 * Пакет здесь — САМ splify2, а не отдельный luci-proto-xsteer. Так решено сознательно:
	 * клиент xsteer это часть движка steer, а страница протокола и обработчик netifd — часть
	 * интерфейса, то есть этого пакета. Отдельный третий пакет означал бы третью версию,
	 * третий барьер релиза и третий способ поставить половину. */
	getPackageName: function() {
		return 'luci-app-splify2';
	},

	isFloating: function() {
		return true;
	},

	isVirtual: function() {
		return true;
	},

	getDevices: function() {
		return null;
	},

	containsDevice: function(ifname) {
		return (network.getIfnameOf(ifname) == this.getIfname());
	},

	renderFormOptions: function(s) {
		var o;

		o = s.taboption('general', form.Value, 'private_key',
			_('Приватный ключ'),
			_('Ключ этой пира, 44 символа base64 — как у WireGuard. Получить: <code>steer xsteer-key</code>. Публичную половину надо отдать хабу.'));
		o.password = true;
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (!value || value.length != 44 || !value.match(/^[A-Za-z0-9+\/]{43}=$/))
				return _('Ожидается 44 символа base64 (32 байта), как печатает steer xsteer-key');
			return true;
		};

		o = s.taboption('general', form.DynamicList, 'addresses',
			_('Адрес в туннеле'),
			_('Адрес этой пира внутри звезды, с префиксом: например <code>10.77.0.2/24</code>. Он же попадает в конфигурацию движка — хаб узнаёт пир по нему.'));
		o.datatype = 'cidr4';
		o.rmempty = false;

		/* ---- загрузка готовой конфигурации ------------------------------------
		 *
		 * Конфигурацию пира печатает установщик хаба (server/xs_install.sh), и без этой формы её
		 * пришлось бы разносить по семи полям руками, сверяя ключи по 44 символа глазами.
		 *
		 * ЗДЕСЬ НЕТ ui.showModal, И ЭТО ГЛАВНОЕ В ЭТОМ БЛОКЕ. Настройки интерфейса в LuCI сами
		 * живут в модальном окне, а окно у LuCI ровно одно: showModal, вызванный изнутри, не
		 * открывает второе, а ЗАМЕНЯЕТ содержимое первого — «Invoking showModal() while a modal
		 * dialog is already open will replace the open dialog with a new one» (ui.js), причём
		 * содержимое ставится через dom.content(), то есть прежние узлы уничтожаются. Разметка
		 * формы интерфейса умирает вместе с ними, и первое же обращение к полю падает:
		 * s.formvalue(sid, 'private_key') → getUIElement → findClassInstance(undefined) →
		 * «Cannot read properties of undefined (reading '_class')». Обработчик кнопки завёрнут в
		 * ui.createHandlerFn, который ждёт обещание, а исключение его отклоняет — значок ожидания
		 * с кнопки уже не снимается, и снаружи это выглядит как «применение висит вечно».
		 *
		 * Поэтому текст вставляется в поле САМОЙ формы, на своей вкладке: разметка живая, все
		 * поля на месте, заменять нечего. Побочно стало лучше: при ошибке разбора вставленный
		 * текст остаётся в поле, а не пропадает вместе с закрытым окном.
		 */
		try {
			s.tab('import', _('Импорт'),
				_('Вставьте конфигурацию или ссылку xs://, которую выдал хаб, — поля на остальных вкладках заполнятся сами. Само по себе это ничего не применяет: проверьте значения и нажмите «Сохранить и применить», как обычно.'));
		} catch (e) {}

		o = s.taboption('import', form.TextValue, '_paste', null,
			_('Два вида одной настройки. Файл в стиле WireGuard: секция <code>[Interface]</code> с приватным ключом и адресом, секция <code>[Peer]</code> с ключом хаба и его адресом; ровно один пир — хаб звезды. Или ссылка <code>xs://…</code> одной строкой — её разберёт движок роутера. Файл можно перетащить прямо в поле.'));
		o.rows = 12;
		o.monospace = true;
		o.placeholder = 'xs://<ключ>@203.0.113.7:443?pk=<ключ хаба>&ip=10.77.0.2/24\n\n— или —\n\n[Interface]\nPrivateKey = …\nAddress = 10.77.0.2/24\n\n[Peer]\nPublicKey = …\nEndpoint = 203.0.113.7:443\nAllowedIPs = 10.77.0.0/24';
		/* Поле формы, но НЕ поле uci: приватный ключ уже лежит в private_key, и вторая его копия
		 * в /etc/config/network была бы вторым местом, откуда его можно прочитать. */
		o.cfgvalue = function() { return ''; };
		o.write = function() {};
		o.remove = function() {};
		/* Перетаскивание файла: конфигурацию чаще приносят файлом, чем из буфера обмена.
		 * Обработчики ставятся на узел, который вернул родительский renderWidget, — событие от
		 * textarea всплывает до него, и внутреннее устройство разметки знать не нужно.
		 *
		 * Родительский метод берётся из прототипа, а не через this.super(): у super() в разных
		 * версиях LuCI разная подпись (массив аргументов против перечисления), и ошибка в ней
		 * проявилась бы только в браузере. */
		var superRenderWidget = form.TextValue.prototype.renderWidget;
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			var node = superRenderWidget.call(this, section_id, option_index, cfgvalue);
			var self = this;
			node.addEventListener('dragover', function(ev) {
				ev.stopPropagation();
				ev.preventDefault();
				ev.dataTransfer.dropEffect = 'copy';
			});
			node.addEventListener('drop', function(ev) {
				ev.stopPropagation();
				ev.preventDefault();
				var file = ev.dataTransfer.files[0];
				if (!file)
					return;
				var reader = new FileReader();
				reader.onload = function(rev) {
					var el = self.getUIElement(section_id);
					if (el)
						el.setValue(String(rev.target.result).trim());
				};
				reader.readAsText(file);
			});
			return node;
		};

		o = s.taboption('import', form.Button, '_import', null,
			_('Разбирает вставленное и заполняет поля. Значения после этого стоит просмотреть: страница не знает, тот ли это хаб, который вы имели в виду.'));
		o.inputtitle = _('Заполнить поля из текста');
		o.inputstyle = 'action';
		/* section_id приходит вторым аргументом от LuCI (form.js, CBIButtonValue.renderWidget) —
		 * берём его, а не s.section: у кнопки нет причин знать, как секция называется снаружи. */
		o.onclick = function(ev, section_id) {
			var sid = section_id || s.section;

			var text = s.formvalue(sid, '_paste');
			if (!text || !String(text).trim().length) {
				ui.addNotification(null, E('p', _('Поле пустое: вставьте конфигурацию пира или ссылку xs://.')), 'warning');
				return;
			}
			text = String(text).trim();

			/* Ссылка уходит на роутер, файл разбирается на месте. Разница не в удобстве: разбор
			 * ссылки живёт в движке (см. callXsteerLink выше), и обойти его значило бы завести
			 * третью реализацию формата. */
			if (/^xs:\/\//i.test(text))
				return callXsteerLink(text).then(function(res) {
					if (!res || !res.ok || !res.conf) {
						ui.addNotification(null, E('p', (res && res.error)
							? res.error
							: _('Роутер не разобрал ссылку.')), 'danger');
						return;
					}
					return fillFromConfig(sid, res.conf);
				}, function() {
					/* Отказ самого вызова — это «движок старый» или «нет прав», и сказать это
					 * надо отдельно от «ссылка негодна»: человек иначе будет править ссылку,
					 * которая в порядке. */
					ui.addNotification(null, E('p',
						_('Роутер не ответил на разбор ссылки. Ссылки понимает steer 1.3.0 и новее — обновите движок или вставьте конфигурацию файлом.')), 'danger');
				});

			return fillFromConfig(sid, text);
		};

		/* Заполнение полей из ТЕКСТА конфигурации — общее для файла и для ссылки: ссылка приезжает
		 * с роутера уже файлом, и второй путь заполнения означал бы два места, где поля ставятся
		 * по-разному. */
		var fillFromConfig = function(sid, text) {
			var parsed = parseXsteerConfig(text);
			if (typeof parsed == 'string') {
				/* Ошибку показываем уведомлением, а текст оставляем в поле: читать сообщение и
				 * править вставленное человек будет одновременно. */
				ui.addNotification(null, E('p', parsed), 'danger');
				return;
			}

			var have = s.formvalue(sid, 'private_key') || uci.get('network', sid, 'private_key');
			if (have && have != parsed.private_key &&
			    !confirm(_('Заменить настройки этого интерфейса вставленной конфигурацией?')))
				return;

			/* Значение ставится в живое поле, если оно нарисовано, и прямо в uci, если нет.
			 * Молча пропустить поле — худший из вариантов: интерфейс выглядел бы настроенным
			 * наполовину, а какая половина потерялась, снаружи не видно. */
			var setField = function(name, value) {
				var opt = s.getOption(name);
				var el = opt ? opt.getUIElement(sid) : null;
				if (el)
					el.setValue(value);
				else
					uci.set('network', sid, name, value);
			};

			setField('private_key', parsed.private_key);
			setField('addresses', parsed.addresses);
			setField('sni', parsed.sni);
			/* MTU переносим только если он в файле ЕСТЬ. Пустое значение здесь означает
			 * «согласуй сам», и подставить в него число значило бы запретить движку поднимать
			 * предел выше — то есть тихо ухудшить туннель. */
			if (parsed.mtu)
				setField('mtu', parsed.mtu);

			/* Хаб заменяется, а не добавляется: пиру нужен ровно один хаб, и оставленный второй
			 * означал бы, что часть трафика идёт мимо звезды. */
			uci.sections('network', 'xsteer_%s'.format(sid), function(old) {
				uci.remove('network', old['.name']);
			});
			var psid = uci.add('network', 'xsteer_%s'.format(sid));
			uci.set('network', psid, 'public_key', parsed.public_key);
			uci.set('network', psid, 'allowed_ips', parsed.allowed_ips);
			uci.set('network', psid, 'endpoint_host', parsed.endpoint_host);
			uci.set('network', psid, 'endpoint_port', parsed.endpoint_port);
			if (parsed.persistent_keepalive)
				uci.set('network', psid, 'persistent_keepalive', parsed.persistent_keepalive);

			/* Предупреждения — уведомлением: файл годен, просто часть его на роутере ничего не
			 * делает, и об этом надо сказать, не мешая импорту. */
			if (parsed.warnings && parsed.warnings.length)
				ui.addNotification(null, parsed.warnings.map(function(w) {
					return E('p', w);
				}), 'warning');
			ui.addNotification(null, E('p',
				_('Поля заполнены. Проверьте их и нажмите «Сохранить и применить».')), 'info');

			/* Перерисовываем: секция хаба создана в обход карты, и без этого её на вкладке не
			 * видно до перезагрузки страницы. Возвращаем обещание — ui.createHandlerFn снимет с
			 * кнопки значок ожидания ровно тогда, когда перерисовка закончится. */
			return s.map.save(null, true);
		};

		o = s.taboption('advanced', form.Value, 'sni',
			_('Маскировочный домен (SNI)'),
			_('Имя, которое уйдёт в ClientHello. Для наблюдателя поток выглядит обычным TLS к этому домену, поэтому имя стоит брать существующее и ничем не выделяющееся.'));
		o.placeholder = 'www.microsoft.com';

		o = s.taboption('advanced', form.Value, 'mtu',
			_('MTU'),
			_('Накладные расходы xsteer — 61 байт, поэтому предел равен MTU канала минус 61: 1439 при обычных 1500 и 1431 на PPPoE. MTU обязан СОВПАДАТЬ у всех участников звезды: при расхождении маленькие пакеты ходят, а большие пропадают — движок предупредит об этом в журнале.'));
		o.datatype = 'range(576,1439)';
		o.placeholder = '1439';

		/* ---- транспорт ---------------------------------------------------------
		 *
		 * Умолчание — поддельный TCP, и менять его без причины не надо: потери наружу остаются
		 * потерями и не превращаются в задержку для внутреннего TCP. Но есть две причины, по
		 * которым туннель иначе не поднимется вовсе, и обе не видны из журнала сразу:
		 * провайдер режет сырые сокеты, и хаб держит только режим потока. */
		/* ---- разгрузка сегментации ---------------------------------------------
		 *
		 * Включена по умолчанию, и ключ здесь стоит не ради выбора. Разгрузка — самая крупная
		 * прибавка к скорости из всего, что есть в туннеле: отдача в устройство 3920 наносекунд на
		 * пакет против 269 в склеенном кадре, на приёме почти вдвое. Выключать её незачем.
		 *
		 * Ключ существует ради одного: возможности вернуться на прежний путь ОДНИМ переключателем,
		 * когда «после обновления стало медленнее или странно». Утверждение «стало быстрее» без
		 * такой возможности человек не может проверить на своём железе никак, кроме сборки из
		 * исходников, — а значит обязан верить на слово. */
		o = s.taboption('advanced', form.Flag, 'offload',
			_('Разгрузка сегментации'),
			_('Отдавать ядру склеенные кадры вместо отдельных пакетов и принимать склеенное от него. Даёт основную часть скорости туннеля, поэтому включена по умолчанию. Выключайте только чтобы сравнить: если после этого стало быстрее, это находка — сообщите её.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('advanced', form.Flag, 'stream',
			_('Записи по настоящему TCP'),
			_('Вместо поддельного TCP — обычное соединение, которое открывает ядро: не нужен ни сырой сокет, ни правило против RST. Включать стоит там, где туннель на поддельном TCP не поднимается (провайдер режет сырые сокеты, нет прав на nft) или где хаб слушает только этот режим. Цена — TCP внутри TCP: потеря наружу становится задержкой, а не потерей. В этом режиме ключи меняются каждые 64 МиБ без разрыва туннеля.'));
		o.default = '0';

		o = s.taboption('advanced', form.Value, 'stream_port',
			_('Порт хаба для потока'),
			_('По умолчанию тот же, что у хаба в настройках. Отдельный порт нужен потому, что хаб, который держит оба режима, не может слушать их на одном: слушающий сокет ядра отвечал бы SYN-ACK и пирам на поддельном TCP.'));
		o.datatype = 'port';
		o.depends('stream', '1');

		o = s.taboption('advanced', form.Value, 'device_name',
			_('Имя устройства'),
			_('По умолчанию <code>xs-&lt;интерфейс&gt;</code> — значит на имя интерфейса остаётся 12 символов. Менять стоит только если имя с чем-то спорит. Ядро принимает не больше 15 символов, и это предел не наш: имя длиннее оно молча обрежет.'));
		o.placeholder = 'xs-%s'.format(s.section);
		/* Предел ядра (IFNAMSIZ — 15 значащих символов) проверяется ЗДЕСЬ, а не только в
		 * обработчике netifd. Отказ обработчика человек видит как «интерфейс не поднялся» в
		 * «Состоянии», то есть на два слоя ниже поля, в которое он вписал имя, и без
		 * подсказки, что дело в длине. Готовый datatype LuCI проверяет ровно то, что нужно:
		 * 1..15 символов, без ':', '/', '%' и пробелов, не «.» и не «..». */
		o.datatype = 'netdevname';

		/* ---- хаб (пир) ------------------------------------------------------- */
		try {
			s.tab('peers', _('Хаб'), _('Пиру нужен ровно один пир — хаб звезды. Сети остальных пиров перечисляются в его AllowedIPs: трафик к ним идёт через хаб.'));
		} catch (e) {}

		o = s.taboption('peers', form.SectionValue, '_peers', form.GridSection,
			'xsteer_%s'.format(s.section));
		/* Без этой строки секция пиров показывалась бы и у интерфейсов с другим протоколом:
		 * так же сделано в amneziawg.js на этом же роутере. */
		o.depends('proto', 'xsteer');
		var ss = o.subsection;
		ss.anonymous = true;
		ss.addremove = true;
		ss.nodescriptions = true;
		ss.modaltitle = _('Хаб звезды');
		ss.addbtntitle = _('Добавить хаб');

		o = ss.option(form.Flag, 'disabled', _('Выключен'));
		o.modalonly = false;

		o = ss.option(form.Value, 'public_key', _('Публичный ключ хаба'));
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (!value || !value.match(/^[A-Za-z0-9+\/]{43}=$/))
				return _('Ожидается 44 символа base64');
			return true;
		};

		o = ss.option(form.DynamicList, 'allowed_ips', _('AllowedIPs'),
			_('Какие адреса идут в туннель. Для звезды это сеть туннеля и сети других пиров; <code>0.0.0.0/0</code> означает «весь трафик через хаб».'));
		o.datatype = 'cidr4';
		o.rmempty = false;

		o = ss.option(form.Value, 'endpoint_host', _('Адрес хаба'),
			_('Только адрес, не имя: разрешение имени пошло бы через DNS, который сам может быть направлен в этот же туннель, — и тогда туннель не поднимется никогда.'));
		o.datatype = 'ip4addr';
		o.rmempty = false;

		o = ss.option(form.Value, 'endpoint_port', _('Порт хаба'),
			_('Обычно 443: на этом порту поток, похожий на TLS, не выделяется среди остального.'));
		o.datatype = 'port';
		o.placeholder = '443';

		o = ss.option(form.Value, 'persistent_keepalive', _('Keepalive, с'),
			_('Пир за NAT обязана поддерживать отображение живым: дозвониться до неё хаб не может. Ноль выключает.'));
		o.datatype = 'range(0,3600)';
		o.placeholder = '25';
	},

	/* Удаление интерфейса обязано забирать и его секции пиров: оставленные `xsteer_<имя>`
	 * висели бы в /etc/config/network навсегда и однажды достались бы новому интерфейсу с тем
	 * же именем — то есть чужой хаб с чужим ключом. */
	deleteConfiguration: function() {
		uci.sections('network', 'xsteer_%s'.format(this.sid), function(s) {
			uci.remove('network', s['.name']);
		});
	}
});
