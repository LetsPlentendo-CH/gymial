const querystring = require("querystring");
const https = require("https");
const express = require("express");
const app = express();
const nodeFetch = require("node-fetch");
const cors = require("cors");
const crypto = require("crypto");
const compression = require("compression");
const iconv = require("iconv-lite");
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const rtg = require("url").parse(process.env.REDISTOGO_URL);
const redis = require("redis").createClient(rtg.port, rtg.hostname);
redis.auth(rtg.auth.split(":")[1]);
const { promisify } = require("util");
const redisHGet = promisify(redis.hget).bind(redis);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // remove once the tam.ch certificate gets recognized

app.use((req, res, next) => {
    if (req.header("x-forwarded-proto") !== "https" && req.hostname !== "localhost" && !req.hostname.includes("192.168")) {
        res.redirect(301, `https://${req.header("host")}${req.url}`);
    } else {
        if (req.headers.cookie) {
            let user = cookieToUser(req.headers.cookie);
            isAuthorized(user).then(isAuth => {
                if (isAuth) {
                    redis.hincrby("user:" + user.username, "requests", 1);
                } else {
                    redis.incr("nonAuthReqs");
                }
            });
        }
        next();
    }
});

app.use(cors());
app.use(compression());
app.use(express.static("static"));

let headers = {
    "Connection": "keep-alive",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Origin": "https://intranet.tam.ch",
    "X-Requested-With": "XMLHttpRequest",
    "Accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
    "User-Agent": "Node.js application",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Host": "intranet.tam.ch",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Referer": "https://intranet.tam.ch/kzo",
    "Cookie": "username=liam.braun; school=kzo; sturmuser=liam.braun; sturmsession=61h71r9jtijgsammm7fu6lr4gl"
};

let kzoCHCookies = {};

const PORT = process.env.PORT || 3000;

let options = {
    hostname: "intranet.tam.ch",
    port: 443,
    path: "/kzo/timetable/ajax-get-timetable",
    method: "POST",
    headers: headers,
};

let token = "";

const periods = [
    {
        "period": 74,
        "startTime": 1614553200000
    },
    {
        "period": 73,
        "startTime": 1597615200000
    },
    {
        "period": 72,
        "startTime": 1582498800000
    },
    {
        "period": 71,
        "startTime": 0
    }
];
function generateAPIKey() {
    return crypto.randomBytes(16).toString("hex");
}

function login(username, password) {
    return new Promise((resolve) => {
        let body = {
            loginuser: username,
            loginpassword: password,
            loginschool: "kzo"
        };
    
        options.path = "/kzo/";

        let tmpOptions = JSON.parse(JSON.stringify(options));
        tmpOptions.headers["Cookie"] = null;
    
        let req = https.request(tmpOptions, res => {
            let setCookies = res.headers["set-cookie"];
            let sturmsession;
            let str = "";
            let newCookies = "";
            if (setCookies) {
                for (let c of setCookies) {
                    newCookies += c.split(";")[0] + "; ";
                    sturmsession = c.match(/sturmsession=[0-9a-z]+/);
                }
            }
            if (!sturmsession) resolve();
            let tmpOpts = JSON.parse(JSON.stringify(options));
            tmpOpts.path = "/kzo/list/index/list/30";
            tmpOpts.headers["Cookie"] = newCookies;
            tmpOpts.method = "GET";
            let req2 = https.request(tmpOpts, res => {
                res.on("data", d => {
                    str += d.toString();
                });
                res.on("end", () => {
                    let user = JSON.parse(str.match(/{\"data\":\[.+?}\].*?}/g));
                    resolve([sturmsession, user]);
                });
            });
            req2.end();
        });
    
        req.write(querystring.stringify(body));
        req.end();
    });
}

function objToCookie(obj) {
    let res = "";
    for (let el in obj) {
        res += el + "=" + obj[el] + ";";
    }
    return res;
}

function loginRegularKZO(user, pass) {
    return new Promise((resolve, reject) => {
        nodeFetch("https://www.kzo.ch/index.php?id=intranet", {
            "headers": {
                "accept": "text/html,application/xhtml+xml,application/xml",
                "cache-control": "no-cache",
                "content-type": "application/x-www-form-urlencoded",
                "pragma": "no-cache",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-origin",
                "sec-fetch-user": "?1",
                "upgrade-insecure-requests": "1"
            },
            "referrer": "https://www.kzo.ch/index.php?id=intranet",
            "referrerPolicy": "no-referrer-when-downgrade",
            "body": `user=${user}&pass=${pass}&submit=Anmelden&logintype=login&pid=712`,
            "method": "POST",
            "mode": "cors"
        }).then(res => {
            let setCookies = res.headers.raw()["set-cookie"];
            kzoCHCookies = {};
            if (setCookies) {
                for (let c of setCookies) {
                    let tmp = c.split("=");
                    kzoCHCookies[tmp[0]] = tmp[1].split("; ")[0];
                }
                resolve();
            }
            reject();
        });
    });
}

function searchPeopleKzoCH(firstName, lastName, classToSearch) {
    return new Promise(async (resolve) => {
        if (!kzoCHCookies.PHPSESSID) {
            await loginRegularKZO(process.env.user, process.env.password);
        }
        nodeFetch("https://www.kzo.ch/index.php?id=549", {
            "headers": {
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
                "accept-charset": "utf-8;q=0.9",
                "cache-control": "no-cache",
                "content-type": "application/x-www-form-urlencoded",
                "pragma": "no-cache",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-origin",
                "sec-fetch-user": "?1",
                "upgrade-insecure-requests": "1",
                "cookie": objToCookie(kzoCHCookies)
            },
            "referrer": "https://www.kzo.ch/index.php?id=549",
            "referrerPolicy": "no-referrer-when-downgrade",
            "body": `vorname=${firstName}&nachname=${lastName}&klasse=${classToSearch}&search=%3E%3E+suchen`,
            "method": "POST",
            "mode": "cors",
            "credentials": "include"
        }).then(res => res.buffer()).then(res => {
            res = iconv.decode(Buffer.from(res), "iso-8859-1"); // bruh why does kzo.ch use ancient charsets, please just start using utf-8
            if (res.includes("Keine Adressen gefunden")) resolve([]);
            let table = res.match(/<table.*?adressliste">(.|\s)+?<\/table>/g)[0];
            let rows = table.match(/<tr.*?>(.|\s)+?<\/tr>/g);
            let json = [];
            for (let i = 1; i < rows.length; i++) { // skip the header row
                let entries = rows[i].match(/<td.*?>(.|\s)+?<\/td>/g);
                json.push([]);
                for (let e of entries) {
                    json[json.length - 1].push(e.replace(/<td.*?>/, '').replace(/<\/td>/, '').replace("&nbsp;", ''));
                }
            }
            resolve(json)
        });
    });
}

function getShit(endpoint, body) {
    options.path = endpoint;
    body.csrfToken = token;
    return new Promise(function(resolve) {
        let str = "";

        let req = https.request(options, res => {
            res.on("data", d => {
                str += d.toString();
            });
            res.on("end", () => {
                if (str[0] === "<" || str.length == 0) { // invalid session
                    console.log("logging in...");
                    login(process.env.user, process.env.password).then((sessionToken) => {
                        if (sessionToken != null) {
                            let token = sessionToken[0];
                            headers["Cookie"] = "username=liam.braun; school=kzo; sturmuser=liam.braun; " + token;
                        }
                        nodeFetch("https://intranet.tam.ch/kzo", {headers: headers}).then(r => r.text()).then(r => {
                            token = r.match(/csrfToken='([0-z]+)/)[1];
                            getShit(endpoint, body).then(r => {
                                resolve(r);
                            });
                        });
                    });
                } else {
                    resolve(str);
                }
            });
        });
    
        req.write(querystring.stringify(body));
        req.end();
    });
}

async function verifyAuthentication(username, password) {
    let token = await login(username, password);
    redis.hset("user:" + username, "persData", JSON.stringify(token[1]));
    return !!(token);
}

function getPeriod(time) {
    let currPeriod;
    for (period of periods) {
        if (time >= period.startTime) {
            currPeriod = period.period;
            break;
        }
    }
    return currPeriod;
}

function cookieToUser(cookie) {
    if (!cookie) return {};
    let splitCookie = cookie.replace(/ /g, '').split(";");
    let cookies = {};
    for (let value of splitCookie) {
        if (value.split('=').length == 2) {
            cookies[value.split('=')[0]] = value.split('=')[1];
        }
    }
    cookies.username = toStandardFormat(cookies.username);
    return cookies;
}

async function isAuthorized(user) {
    if (!user) return false;
    if (!user.username || !user.apiToken) return false;
    correctAPIToken = await redisHGet("user:" + user.username, "token");
    if (correctAPIToken == null) return false;
    return (user.apiToken == correctAPIToken);
}

function toStandardFormat (token) {
    return token.toLowerCase().replace(/\@studmail.kzo.ch/g, "").trim();
}

app.post("/auth", function (req, res) {
    var body = "";
    req.on("data", chunk => {
        body += chunk.toString();
    });
    req.on("end", () => {
        let bodySplitted = body.split('&');
        let bodyJSON = {};
        for (let arg of bodySplitted) {
            bodyJSON[arg.split('=')[0]] = arg.split('=')[1];
        }
        if (bodyJSON.user && bodyJSON.pass) {
            bodyJSON.user = toStandardFormat(bodyJSON.user);
            verifyAuthentication(bodyJSON.user, bodyJSON.pass).then(r => {
                if (r) {
                    let token = generateAPIKey();
                    redis.hset("user:" + bodyJSON.user, "token", token);
                    redis.hget("user:" + bodyJSON.user, "requests", (err, res) => {
                        if (res == null) redis.hset("user:" + bodyJSON.user, "requests", 0);
                    });
                    res.send(token).end();
                    return;
                }
                res.status(401).end();
            });
        }
    });
});

app.get("/myData", function (req, res) {
    let user = cookieToUser(req.headers.cookie);
    isAuthorized(user).then(isAuth => {
        if (!isAuth) {
            res.send({
                data: [],
                total: 0
            });
            return;
        }
        redis.hget("user:" + user.username, "persData", (err, r) => {
            if (r == null) {
                res.send({
                    data: [],
                    total: 0
                });
                return;
            }
            res.send(JSON.parse(r));
        });
    });
});

app.get("/timetable/:type/:id/:time", function (req, res) {
    let body = {
        "startDate": req.params.time,
        "endDate": parseInt(req.params.time) + 4 * 24 * 60 * 60 * 1000,
        "holidaysOnly": 0,
        "method": "POST"
    };
    switch (req.params.type) {
        case "class":
        case "teacher":
        case "student":
        case "room":
            break;
        default:
            res.status(400).end();
            return;
    }
    body[req.params.type + "Id[]"] = req.params.id;
    getShit("/kzo/timetable/ajax-get-timetable", body).then(r => {
        isAuthorized(cookieToUser(req.headers.cookie)).then(isAuth => {
            if (!isAuth) {
                let json = JSON.parse(r).data;
                const propsToKeep = [
                    "id", "periodId", "start", "end", "lessonDate", "lessonStart", "lessonEnd", "lessonDuration",
                    "timetableEntryTypeId", "timetableEntryType", "timetableEntryTypeLong", "timetableEntryTypeShort",
                    "title", "courseId", "courseName", "course", "subjectName", "classId", "className", "teacherAcronym",
                    "roomId", "roomName", "teacherId"
                ]
                let basicJSON = new Array(json.length);
                for (let i = 0; i < json.length; i++) {
                    basicJSON[i] = {};
                    for (let p of propsToKeep) {
                        basicJSON[i][p] = json[i][p];
                    }
                }
                res.send(basicJSON);
            } else {
                res.send(JSON.parse(r).data);
            }
        });
    });
});

app.get("/course-participants/:id", function (req, res) {
    isAuthorized(cookieToUser(req.headers.cookie)).then(isAuth => {
        if (!isAuth) {
            res.status(401).end();
            return;
        }
        let body = {
            "method": "GET"
        };
        getShit(`/kzo/list/getlist/list/40/id/${req.params.id}/period/73`, body).then(r => {
            res.send(JSON.parse(r).data.map(el => {
                return {
                    "name": el.Name + ", " + el.Vorname,
                    "id": el.PersonID
                };
            }));
        });
    });
});

app.get("/picture/:id", function (req, res) {
    isAuthorized(cookieToUser(req.headers.cookie)).then(isAuth => {
        if (!isAuth) {
            res.status(401).end();
            return;
        }
        let body = {
            "person": req.params.id,
            "method": "POST"
        };
        getShit("/kzo/list/get-person-picture", body).then((r) => {
            res.writeHead(200, {
                "Content-Type": "image/jpeg",
                "Content-Length": Buffer.from(r, "base64").length
            });
            res.end(Buffer.from(r, "base64"));
        });
    });
});

app.get("/resources/:time", function (req, res) {
    console.log("period", getPeriod(req.params.time));
    let body = {
        "periodId": getPeriod(req.params.time),
        "method": "POST"
    };
    getShit("/kzo/timetable/ajax-get-resources/", body).then(r => {
        isAuthorized(cookieToUser(req.headers.cookie)).then(isAuth => {
            if (!isAuth) {
                res.send({
                    "offline": false,
                    "data": JSON.parse(r).data.classes
                });
                return;
            }
            res.send({
                "offline": false,
                "data": [...JSON.parse(r).data.classes, ...JSON.parse(r).data.teachers, ...JSON.parse(r).data.students, ...JSON.parse(r).data.rooms]
            });
        });
    });
});

app.get("/getName/:id", function (req, res) {
    isAuthorized(cookieToUser(req.headers.cookie)).then(isAuth => {
        if (!isAuth) {
            res.status(401).end();
            return;
        }
        let body = {
            "id": req.params.id,
            "method": "POST"
        };
        getShit("/kzo/list/get-person-name", body).then((r) => {
            res.send(r);
        });
    });
});

app.get("/search-internal-kzoCH/:firstName/:lastName/:class", function(req, res) {
    isAuthorized(cookieToUser(req.headers.cookie)).then(isAuth => {
        if (!isAuth) {
            res.status(401).end();
            return;
        }
        let fN = "";
        let lN = "";
        let cl = "";
        if (req.params.firstName != "_") fN = req.params.firstName;
        if (req.params.lastName != "_") lN = req.params.lastName;
        if (req.params.class != "_") cl = req.params.class;
        searchPeopleKzoCH(fN, lN, cl).then(r => res.send(r));
    });
});

app.get("/class-personal-details/:classID", function (req, res) {
    isAuthorized(cookieToUser(req.headers.cookie)).then(isAuth => {
        if (!isAuth) {
            res.status(401).end();
            return;
        }
        /*
        (Taken down in the mean time)
        let body = {
            "method": "GET"
        };
        let period = 72;
        if (req.params.classID >= 2438) period = 73;
        getShit("/kzo/list/getlist/list/12/id/" + req.params.classID + "/period/" + period, body).then(r => {
            res.send(r);
        });
        */
        let startTime = periods[1].startTime;
        if (req.params.classID >= 2438) startTime = periods[0].startTime;
        let body = {
            "startDate": startTime,
            "endDate": startTime + 4 * 24 * 60 * 60 * 1000,
            "holidaysOnly": 0,
            "method": "POST",
            "classId[]": req.params.classID
        };
        getShit("/kzo/timetable/ajax-get-timetable", body).then(r => {
            let data = JSON.parse(r).data;
            let classList = [];
            for (let c of data) {
                if (c.classId.length == 1 && c.student.length > classList.length) {
                    classList = c.student;
                }
            }
            res.send(classList);
        });
    });
});

app.get("/period-from-time/:time", function (req, res) {
    res.end(getPeriod(req.params.time).toString());
});

let mensaPlan;

app.get("/mensa", function (req, res) {
    if (mensaPlan) {
        res.send(mensaPlan).end();
        return;
    }
    res.status(404).end();
});

updateMensaCache();
setInterval(updateMensaCache, 1000 * 60 * 60);

function updateMensaCache() {
    nodeFetch("https://menu.sv-group.ch/typo3conf/ext/netv_svg_menumob/ajax.getContent.php", {
        "headers": {
            "content-type": "application/x-www-form-urlencoded",
        },
        "body": "action=getMenuplan&params%5Bbranchidentifier%5D=7912",
        "method": "POST",
        "mode": "cors"
    }).then(res => res.json()).then(res => {
        mensaPlan = res[0].html;
        const dom = new JSDOM(res[0].html);
        let menu = {};
        let days = dom.window.document.getElementsByClassName("day-tab");
        for (let day of days) {
            let menus = day.getElementsByClassName("details-menu");
            let dayName = day.getElementsByClassName("details-date")[0].textContent;
            dayName = dayName.split(". ").join(".");
            menu[dayName] = [];
            for (let m of menus) {
                let kitchenName = m.getElementsByClassName("details-menu-type")[0].textContent;
                let menuName = m.getElementsByClassName("details-menu-name")[0].textContent;
                let menuDescription = m.getElementsByClassName("details-menu-trimmings")[0].textContent;
                menu[dayName].push({
                    kitchen: kitchenName,
                    title: menuName,
                    description: menuDescription.replace(/\n/g, ' ').replace(/  /g, ' ')
                });
            }
        }
        mensaPlan = menu;
    });
}

app.listen(PORT, () => console.log("Web server is up and running on port " + PORT));
