require('dotenv').load();

var restify = require('restify');
var builder = require('botbuilder');
var jenkinsapi = require('jenkins-api');
var fs = require('fs');
var URL = require('url');
var Velocity = require('velocityjs');
var autostart = require('node-autostart')

var nconf = require('nconf');
nconf.use('file', {file: './config.json'});
nconf.load();
var chatsConfig = nconf.get('chats');

autostart.isAutostartEnabled(process.env.npm_package_name, function (err, isEnabled) {
    if (!isEnabled) {
        autostart.enableAutostart(process.env.npm_package_name, 'npm start', process.cwd(), function (err) {
            if(err) console.error(err);
            console.log('Autostart is jenbot ' + isEnabled ? 'enabled' : 'not enabled');
        });
    }
});

// Setup Restify Server
var server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, function () {
    console.log('%s listening to %s', server.name, server.url);
});

// Create chat connector for communicating with the Bot Framework Service
var connector = new builder.ChatConnector({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD
});

var jenkins = jenkinsapi.init("https://" + process.env.JENKINS_TOKEN + "@" + process.env.JENKINS_URL);

// Listen for messages from users
server.post('/api/messages', connector.listen());

function getJobUrl(job) {
    return "[" + job + "](https://" + process.env.JENKINS_URL + "/job/" + job + ")";
}

function selectMessage(event, query) {
    switch (event) {
        case 'jenkins.computer.failure':
            return 'Проблема со сборщиком ' + query.computer;
        case 'jenkins.computer.offline':
            return 'Сборщик ' + query.computer + ' выключен';

        case 'jenkins.shutdown':
            return 'Дженкинс выключается';
        case 'jenkins.started':
            return 'Дженкинс запущен';

        case 'jenkins.queue.enter.waiting':
            return 'Задача ' + getJobUrl(query.job) + ' поставлена в очередь';
        case 'jenkins.queue.onleft':
            return query.cancelled==='true' ? 'Задача ' + getJobUrl(query.job) + ' удалена из очереди' : '';

        case 'jenkins.job.started':
            return 'Задача ' + getJobUrl(query.job) + ' запущена';
        case 'jenkins.job.completed':
            var result;
            switch (query.status) {
                case 'FAILURE': result = 'завершилась ошибкой'; break;
                case 'NOT_BUILT': result = 'была отменена'; break;
                default:
                    result = 'собрана успешно';
            }
            return 'Задача ' + getJobUrl(query.job) + ' ' + result;
    }
    return ''
}

var jenkinsHook = function (req, res) {
    var url = URL.parse(req.url, true);
    // console.log(url.query);
    // var params = JSON.parse(url.query);
    // console.log(params);
    var event = url.query.event;
    var job = url.query.job;
    var computer = url.query.computer;
    var message = selectMessage(event, url.query);
    // console.log(event);
    if (!event || message === '') {
        res.writeHead(200, {'Content-Type': 'text/json'});
        res.end("{'result':false}");
        return
    }
    if (job) {
        chatsConfig.forEach(function (chat) {
            var builds = chat.build;
            var found = false;
            for (var b in builds) {
                if (builds[b] === job) {
                    sendProactiveMessage(chat.address, message);
                    found = true;
                    break;
                }
            }
            if (!found) {
                builds = chat.buildParametrized;
                for (var b in builds) {
                    if (builds[b] === job) {
                        sendProactiveMessage(chat.address, message);
                        break;
                    }
                }
            }
        });
    } else if (computer) {
        chatsConfig.forEach(function (chat) {
            var computers = chat.computers;
            for (var c in computers) {
                if (c === computer) {
                    sendProactiveMessage(chat.address, message);
                    break;
                }
            }
        });
    } else {
        chatsConfig.forEach(function (chat) {
            sendProactiveMessage(chat.address, message);
        });
    }


    res.writeHead(200, {'Content-Type': 'text/json'});
    res.end("{'result':true}");
};

// Listen Jenkins events
server.get('/api/events', jenkinsHook);

function findCommand(message) {
    var match = /(\w+)\s*/.exec(message);
    return match !== null ? match[1] : null;
}

function findArgs(message) {
    var match = /\w+\s+(.*)/.exec(message);
    return match !== null ? match[1].split(" ") : [];
}

function doInit(session, project) {
    if (project) {
        for (var i in chatsConfig) {
            var chat = chatsConfig[i];
            if (chat.name === project) {
                chatsConfig[i].address = session.message.address;
                nconf.save(function (err) {
                    if (err) {
                        console.error(err.message);
                        return;
                    }
                    console.log('Чат ' + project + ':' + session.message.address + ' проинициализирован');
                });
                session.conversationData['project'] = project;
                session.save();
                return true;
            }

        }
    }

    return false;
}

function getChatOptions(channelId) {
    for (var i in chatsConfig) {
        var chat = chatsConfig[i];
        if (chat.address.channelId === channelId) {
            return chat;
        }
    }

    return null;
}

function preInit(session) {
    if (!session.conversationData['queued']) {
        session.conversationData['queued'] = [];
    }
    if (session.conversationData['project'] && getChatOptions(session.message.address.channelId) === null) {
        doInit(session, session.conversationData['project']);
    }
    session.save();
}

var bot = new builder.UniversalBot(connector, function (session) {
    preInit(session);

    var message = session.message.text;
    var command = findCommand(message);
    var args = findArgs(message);

    // console.log(command);
    // console.log(args);
    if (command === null) {
        return
    }
    var chatOptions = getChatOptions(session.message.address.channelId);
    if (chatOptions === null && command !== 'init' && command !== 'help') {
        session.send('Неизвестный идентификатор чата ' + session.message.address.channelId + ". Отправьте боту init **&lt;код чата&gt;**");
        return
    }
    var job;
    switch (command) {
        case 'help':
            fs.readFile("help.md", "utf8", function (err, data) {
                var jobs = [];
                if (chatOptions !== null) {
                    for (var b in chatOptions.build) {
                        jobs.push(b)
                    }
                    for (var b in chatOptions.buildParametrized) {
                        jobs.push(b)
                    }
                    chatOptions.check.forEach(function (job) {
                        jobs.push(job)
                    });
                }

                var ast = Velocity.render(data, {
                    "context": {
                        "jobs": jobs
                    }
                });
                session.send(ast);
            });
            break;
        case 'init':
            if (args.length < 1) {
                session.send("Не указан код чата")
            } else if (doInit(session, args[0])) {
                session.send("Бот готов к работе")
            } else {
                session.send("Бот не инициализирован. Проверьте конфигурацию")
            }
            break;
        case 'check':
            chatOptions.check.forEach(function (job) {
                jenkins.last_build_info(job, function (err, data) {
                    if (err) {
                        return console.log(err);
                    }
                    session.send(getJobUrl(job) + ' ' + data.result);
                });
            });
            break;
        case 'build':
            var isParametrized = false;
            var isBuildJob = false;
            job = chatOptions.build[args[0]];
            if (!job) {
                chatOptions.check.forEach(function (chJob) {
                    if (chJob === args[0]) {
                        job = chJob;
                    }
                });
            } else {
                isBuildJob = true;
            }
            if (!job) {
                job = chatOptions.buildParametrized[args[0]];
                isParametrized = true;
                isBuildJob = true;
            }

            if (job) {
                var callback = function (err, data) {
                    if (err) {
                        return console.log(err);
                    }

                    if (data.queueId) {
                        session.conversationData.queued[job] = data.queueId;
                        session.save();
                    }
                };
                //todo разобраться с параметрами
                var params = {depth: 1};
                if (isBuildJob) {
                    params['delay'] = process.env.BUILD_DELAY || '600sec';
                }
                if (isParametrized) {
                    if (1 < args.length) {
                        args.forEach(function (t) {
                            if (t !== args[0]) {
                                params[t] = true
                            }
                        });
                        console.log(params);
                    }
                    jenkins.build_with_params(job, params, callback);
                } else {
                    jenkins.build(job, params, callback);
                }
            }
            break;
        case 'stop':
            job = chatOptions.build[args[0]];
            if (!job) {
                chatOptions.check.forEach(function (chJob) {
                    if (chJob === args[0]) {
                        job = chJob;
                    }
                });
            }
            if (!job) {
                job = chatOptions.buildParametrized[args[0]];
            }

            if (job && session.conversationData.queued[job]) {
                var callback = function (err, data) {
                    if (err) {
                        return console.log(err);
                    }

                    console.log(data)
                };
                jenkins.stop_build(job, session.conversationData.queued[job], callback);
                session.conversationData.queued[job] = null;
                session.save();
            }
            break;
    }
});

bot.set('persistConversationData', true);

function sendProactiveMessage(address, message) {
    console.log(message);
    var msg = new builder.Message().address(address);
    msg.text(message);
    msg.textLocale('ru-RU');
    bot.send(msg);
}
