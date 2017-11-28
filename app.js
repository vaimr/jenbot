require('dotenv').load();

var restify = require('restify');
var builder = require('botbuilder');
var jenkinsapi = require('jenkins-api');
var fs = require('fs');
var URL = require('url');
var Velocity = require('velocityjs');
var autostart = require('node-autostart');
var ping = require("net-ping");
var lookup = require('dns-lookup');
var when = require('when');
var Client = require('node-rest-client').Client;
var Set = require("collections/set");
var log4js = require('log4js');
log4js.configure({
    appenders: {
        app: {type: 'dateFile', filename: process.env.LOGS_DIR + 'app.log', pattern: '-yyyy-MM-dd'},
        con: {type: 'console'}
        },
    categories: {default: {appenders: ['app', 'con'], level: 'info'}}
});

var logger = log4js.getLogger('app');

var nconf = require('nconf');
var configFile = './config.json';
var chatsConfig;

var startedJobs = {};

fs.exists(process.env.CONFIG_FILE, function (exists) {
    if (exists) {
        configFile = process.env.CONFIG_FILE;
        logger.info('Loading config: ' + configFile);
    }
    nconf.use('file', {file: configFile});
    nconf.load();
    chatsConfig = nconf.get('chats');
});

if (process.env.npm_package_name) {
    autostart.isAutostartEnabled(process.env.npm_package_name, function (err, isEnabled) {
        if (!isEnabled) {
            autostart.enableAutostart(process.env.npm_package_name, 'npm start', process.cwd(), function (err) {
                if (err) {
                    logger.error(err);
                }
                logger.info('Autostart is jenbot ' + isEnabled ? 'enabled' : 'not enabled');
            });
        }
    });
}

// Setup Restify Server
var server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, function () {
    logger.info('%s listening to %s', server.name, server.url);
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
    return "[" + job.replace(/job\//, '') + "](https://" + process.env.JENKINS_URL +
        (job.startsWith('/job') ? job : "/job/" + job) + ")";
}

function selectMessage(event, query) {
    switch (event) {
        case 'jenkins.computer.failure':
            return 'Проблема со сборщиком ' + query.computer;
        case 'jenkins.computer.offline':
            return 'Сборщик ' + query.computer + ' выключен';
        case 'jenkins.computer.online':
            return 'Сборщик ' + query.computer + ' включен';

        case 'jenkins.shutdown':
            return 'Дженкинс выключается';
        case 'jenkins.started':
            return 'Дженкинс запущен';

        case 'jenkins.queue.enter.waiting':
            var t = new Date().getTime() + 1000;
            if (t < parseInt(query.timestamp)) {
                return 'Задача ' + getJobUrl(query.job) + ' поставлена в очередь';
            }
            break;
        case 'jenkins.queue.onleft':
            return query.cancelled === 'true' ? 'Задача ' + getJobUrl(query.job) + ' удалена из очереди' : '';

        case 'jenkins.job.started':
            return 'Задача ' + getJobUrl(query.jobUrl) + ' запущена';
        case 'jenkins.job.completed':
            var result;
            switch (query.status) {
                case 'FAILURE':
                    result = 'завершилась ошибкой';
                    break;
                case 'NOT_BUILT':
                    result = 'была отменена';
                    break;
                case 'ABORTED':
                    result = 'была прервана';
                    break;
                case 'UNSTABLE':
                    result = 'собрана. Не стабильна';
                    break;
                default:
                    result = 'собрана успешно';
            }
            return 'Задача ' + getJobUrl(query.jobUrl) + ' ' + result;
    }
    return ''
}

var jenkinsHook = function (req, res) {
    try {
        var url = URL.parse(req.url, true);
        // logger.info(url.query);
        // var params = JSON.parse(url.query);
        // logger.info(params);
        var event = url.query.event;
        var job = url.query.job;
        var computer = url.query.computer;
        var message = selectMessage(event, url.query);
        // logger.info(event);
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
                            found = true;
                            break;
                        }
                    }
                }
                if (!found) {
                    var jobUrl = url.query.jobUrl;
                    if (jobUrl) {
                        logger.trace('hook. started jobs: ' + startedJobs);
                        var startedKey = chat.name + ":" +
                            jobUrl.replace(/job\//, '').replace(/\/$/, '');
                        logger.trace('started key: ' + startedKey);
                        if (startedJobs[startedKey]) {
                            if (event !== 'jenkins.job.started') {
                                startedJobs[startedKey] = false;
                            }
                            sendProactiveMessage(chat.address, message);
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
    } catch (e) {
        logger.error(e);
    }
};

// Listen Jenkins events
server.get('/api/events', jenkinsHook);

function findCommand(message) {
    var match = /\w+\s+(\w+)\s*/.exec(message);
    return match !== null ? match[1] : null;
}

function findArgs(message) {
    var match = /\w+\s+\w+\s+(.*)/.exec(message);
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
                    logger.trace('Чат ' + project + ':' + session.message.address + ' проинициализирован');
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
        if (chat.address !== null && chat.address.id === channelId) {
            return chat;
        }
    }

    return null;
}

function preInit(session) {
    if (!session.conversationData['queued']) {
        session.conversationData['queued'] = [];
    }
    if (session.conversationData['project'] && getChatOptions(session.message.address.id) === null) {
        doInit(session, session.conversationData['project']);
    }
    session.save();
}

var bot = new builder.UniversalBot(connector, function (session) {
    try {
        processMessage(session);
    } catch (e) {
        logger.error(e);
    }
});

function processMessage(session) {
    preInit(session);

    var message = session.message.text;
    var command = findCommand(message).toLowerCase();
    var args = findArgs(message);

    logger.trace(command);
    logger.trace(args);
    if (command === null) {
        return
    }
    var chatOptions = getChatOptions(session.message.address.id);
    if (chatOptions === null && command !== 'init' && command !== 'help') {
        session.send('Неизвестный идентификатор чата ' + session.message.address.id + ". Отправьте боту init **&lt;код чата&gt;**");
        return
    }
    var job;
    switch (command) {
        case 'init':
            if (args.length < 1) {
                session.send("Не указан код чата")
            } else if (doInit(session, args[0])) {
                session.send("Бот готов к работе")
            } else {
                session.send("Бот не инициализирован. Проверьте конфигурацию")
            }
            break;
        case 'build':
        case 'start':
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
                        logger.error(err);
                        return;
                    }

                    var queueId = data['queueId'];
                    if (queueId) {
                        if (!session.conversationData.queued || session.conversationData.queued instanceof Array) {
                            session.conversationData.queued = {};
                        }
                        logger.trace(session.conversationData.queued);
                        session.conversationData.queued[job] = queueId;
                        session.save();
                    }
                };
                //todo разобраться с параметрами
                var params = {depth: 1};
                if (isBuildJob) {
                    params['delay'] = process.env.BUILD_DELAY || '600sec';
                } else {
                    logger.trace('start. started jobs : ' + startedJobs);
                    startedJobs[chatOptions.name + ":" + job] = true;
                }
                if (isParametrized) {
                    if (1 < args.length) {
                        args.forEach(function (t) {
                            if (t !== args[0]) {
                                params[t] = true
                            }
                        });
                        logger.trace(params);
                    }
                    jenkins.build_with_params(job, params, callback);
                } else {
                    jenkins.build(job, params, callback);
                }
            }
            break;
        case 'stop':
        case 'abort':
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

            logger.trace('cancel ' + job + ' ' + session.conversationData.queued[job]);
            if (job && session.conversationData.queued[job]) {
                jenkins.cancel_item(session.conversationData.queued[job], function (err, data) {
                    if (err) {
                        logger.error(err);
                        return;
                    }

                    logger.trace(data)
                });
                session.conversationData.queued[job] = null;
                session.save();
            }
            break;
        case 'help':
        case 'check':
        case 'ping':
        case 'commits':
        case 'detail':
            session.beginDialog('/' + command);
            break;
        default:
            session.beginDialog('/help');
    }
}

bot.set('persistConversationData', true);

bot.dialog('/help', [
    function (session) {
        var chatOptions = getChatOptions(session.message.address.id);
        var promises = [];
        var resultMessage = '';
        var deferred = when.defer();
        promises.push(deferred.promise);
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

            resultMessage = Velocity.render(data, {
                "context": {
                    "jobs": jobs
                }
            });
            deferred.resolve('ok');
        });
        when.all(promises).then(function () {
            session.endDialog(resultMessage);
        });
    }
]);

bot.dialog('/check', [
    function (session) {
        var chatOptions = getChatOptions(session.message.address.id);
        var promises = [];
        var resultMessage = '';

        chatOptions.check.forEach(function (job) {
            var deferred = when.defer();
            jenkins.last_build_info(job, function (err, data) {
                if (err) {
                    logger.error(err);
                } else {
                    var status = data.result === 'SUCCESS' ? '😊' : '😣';
                    resultMessage += getJobUrl(job) + ' ' + status + '<br/>';
                }
                deferred.resolve('ok');
            });
            promises.push(deferred.promise);
        });

        when.all(promises).then(function () {
            session.endDialog(resultMessage);
        });
    }
]);

bot.dialog('/ping', [
    function (session) {
        var message = session.message.text;
        var args = findArgs(message);
        var promises = [];
        var resultMessage = '';

        args.forEach(function (t) {
            var deferred = when.defer();
            lookup(t, function (err, address, family) {
                if (err) {
                    resultMessage += t + ': недоступен ' + err + '<br/>';
                    deferred.resolve('ok');
                } else {
                    var pingSession = ping.createSession();

                    pingSession.pingHost(address, function (error, target) {
                        if (error)
                            resultMessage += t + ': ' + error.toString() + ' (' + address + ')<br/>';
                        else
                            resultMessage += t + ': Доступен (' + address + ')<br/>';
                        deferred.resolve('ok');
                    });
                }
            });
            promises.push(deferred.promise);
        });

        when.all(promises).then(function () {
            session.endDialog(resultMessage);
        });
    }
]);

function getRest(url, args, callback) {
    var client = new Client();
    var req = client.get(url, args, function (data, response) {
        callback(null, data);
    });

    req.on('requestTimeout', function (req) {
        logger.error('request has expired');
        req.abort();
        callback('requestTimeout', null);
    });

    req.on('responseTimeout', function (res) {
        logger.error('response has expired');
        callback('responseTimeout', null);
    });

    req.on('error', function (err) {
        logger.error('request error', err);
        callback('error', null);
    });
}

function getJiraUrl() {
    return process.env.JIRA_URL.toLowerCase().startsWith('http') ? process.env.JIRA_URL :
        'https://' + process.env.JIRA_URL;
}

function authJira(callback) {
    var client = new Client();
    var loginArgs = {
        data: {
            "username": process.env.JIRA_USER,
            "password": process.env.JIRA_PASSWORD
        },
        headers: {
            "Content-Type": "application/json"
        }
    };

    client.post(getJiraUrl() + "/rest/auth/1/session", loginArgs, function (data, response) {
        if (response.statusCode === 200) {
            var session = data.session;
            callback(session.name + '=' + session.value);
        } else {
            throw "Login failed :(";
        }
    });
}

function getIssueId(issueNumber, args, callback) {
    getRest(getJiraUrl() + '/rest/api/2/issue/' + issueNumber, args, function (err, data) {
        callback(err, data['id']);
    });
}

function getCommitsId(issueId, args, callback) {
    getRest(getJiraUrl() +
        '/rest/dev-status/latest/issue/detail?issueId=' + issueId +
        '&applicationType=stash&dataType=repository', args, function (err, data) {
        if (data.errorMessages) {
            callback(data.errorMessages, null);
            return;
        }
        if (data['detail'].length <= 0) {
            callback(data['errors'], null);
            return;
        }
        callback(err, data['detail'][0]['repositories']);
    });
}

bot.dialog('/commits', [
    function (session) {
        commits(session, false);
    }
]);
bot.dialog('/detail', [
    function (session) {
        commits(session, true);
    }
]);

function commits(session, detail) {
    var message = session.message.text;
    var args = findArgs(message);
    var promises = [];
    var resultMessage = '';

    authJira(function (cookieValue) {
        var headers = {
            headers: {
                'cookie': cookieValue,
                "Content-Type": "application/json"
            }
        };
        args.forEach(function (t) {
            var deferred = when.defer();
            getIssueId(t, headers, function (err, issueId) {
                if (err) {
                    resultMessage = 'Jira недоступна';
                    deferred.resolve('ok');
                    return;
                }
                getCommitsId(issueId, headers, function (err, repos) {
                    if (err) {
                        resultMessage = 'Jira недоступна';
                        deferred.resolve('ok');
                        return;
                    }

                    repos.forEach(function (repo) {
                        resultMessage += "**[" + repo['name'] + "](" + repo['url'] + ")**<br/>";
                        var files = new Set();
                        repo['commits'].forEach(function (commit) {
                            commit['files'].forEach(function (file) {
                                if (detail) {
                                    switch (file['changeType']) {
                                        case 'MODIFIED':
                                            resultMessage += '~' + file['path'] + '<br/>';
                                            break;
                                        case 'ADDED':
                                            resultMessage += '+' + file['path'] + '<br/>';
                                            break;
                                        case 'DELETED':
                                            resultMessage += '-' + file['path'] + '<br/>';
                                            break;
                                        default:
                                            resultMessage += file['changeType'] + ' ' + file['path'] + '<br/>';
                                    }
                                } else {
                                    files.add(file['path']);
                                }
                            });
                        });
                        files.forEach(function (file) {
                            resultMessage += file + '<br/>';
                        })
                    });
                    deferred.resolve('ok');
                });
            });
            promises.push(deferred.promise);
        });

        when.all(promises).then(function () {
            session.endDialog(resultMessage);
        });
    });
}

function sendProactiveMessage(address, message) {
    logger.trace(message);
    var msg = new builder.Message().address(address);
    msg.text(message);
    msg.textLocale('ru-RU');
    bot.send(msg);
}
