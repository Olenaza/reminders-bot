'use strict';
 
const functions = require('firebase-functions');
const {WebhookClient} = require('dialogflow-fulfillment');
const {Card, Suggestion, Payload} = require('dialogflow-fulfillment');
const admin = require('firebase-admin');
const schedule = require('node-schedule');
 
process.env.DEBUG = 'dialogflow:debug';
admin.initializeApp();
const db = admin.firestore();
 
exports.dialogflowFirebaseFulfillment = functions.https.onRequest((request, response) => {
  const agent = new WebhookClient({ request, response });
  console.log('Dialogflow Request headers: ' + JSON.stringify(request.headers));
  console.log('Dialogflow Request body: ' + JSON.stringify(request.body));
 
  function welcome(agent) {
    const userId = request.body.originalDetectIntentRequest.payload.data.message.from.id.toString();
    
    const result = {
        "chat_id": userId,
        "text": "Welcome!",
        "parse_mode": "markdown",
        "reply_markup": {
            "keyboard": [
                [{"text": "Create reminder"}],
                [{"text": "Show today reminders"}]
            ],
            "resize_keyboard": true,
            "one_time_keyboard": true
        }
    };
        
    const payload = new Payload(agent.TELEGRAM, {});
    payload.setPayload(result);
    agent.add(payload);
  }
 
  function fallback(agent) {
    agent.add(`I didn't understand`);
    agent.add(`I'm sorry, can you try again?`);
  }

  function addReminder (agent) {
    const text = agent.parameters.text;
    let time = agent.parameters.time;
    time = typeof(time) === 'object' ? time.date_time : time;
    const userId = request.body.originalDetectIntentRequest.payload.data.message.from.id.toString();
    
    const dateObj = new Date(time);
    const id = text + dateObj.getTime();

    const remindersRef = db.collection('reminders').doc(userId);
    return db.runTransaction(t => {
        return t.get(remindersRef)
        .then(doc => {
            const reminder = {
                time: time,
                text: text,
                id: id,
            };
            if (!doc.exists) {
                t.set(remindersRef, {
                    reminders: [reminder]
                });
            } else {
                t.update(remindersRef, {
                    reminders: admin.firestore.FieldValue.arrayUnion(reminder)
                });
            }
            
            schedule.scheduleJob(id, dateObj, function(text, time) {
            agent.setFollowupEvent({
                name: "alert",
                languageCode: "en-US",
                parameters: {
                    text: text,
                    time: time
                },
            });
        }.bind(null, text, time));
        });
    }).then(result => {
        agent.add(`A reminder "${text}" for ${time.substr(0, 10)} at ${time.substr(11, 5)} was added.`);
        console.log('Write complete');
    }).catch(err => {
        console.log(`Error writing to Firestore: ${err}`);
        agent.add(`Failed to write new reminder to the Firestore database. Please try again`);
    });
  }
  
  function showReminders (agent) {
    const date = agent.parameters.date.substr(0, 10);
    const userId = request.body.originalDetectIntentRequest.payload.data.message.from.id.toString();

    const remindersRef = db.collection('reminders').doc(userId);
    return remindersRef.get()
    .then(doc => {
        let results = [];
            
        if (doc.exists) {
            doc.data().reminders.forEach(function(item, index) {
                if (item.time.substr(0, 10) === date) {
                    results.push([
                        {
                            "text": `${item.text} at ${item.time.substr(11, 5)}`,
                            "callback_data": `Details for ${item.text} at ${item.time.substr(0, 10)} ${item.time.substr(11, 5)}`
                        }]);
                        
                    results.push([
                        {
                            "text": "Rename",
                            "callback_data": `Rename ${item.text} to`
                        },
                        {
                            "text": "Reschedule",
                            "callback_data": `move ${item.text} at ${item.time.substr(0, 10)} ${item.time.substr(11, 5)}`
                        },
                        {
                            "text": "Delete",
                            "callback_data": `Delete ${item.text} for ${item.time.substr(0, 10)} ${item.time.substr(11, 5)}`
                        }]);
                }
            });
        }
            
        if (results.length === 0) {
            agent.add(`You have no reminders for ${date}`);
        } else {
            const result = {
                "chat_id": userId,
                "text": `*Reminders for ${date}:*`,
                "parse_mode": "markdown",
                "reply_markup": {
                    "inline_keyboard": results
                }
            };
                
            const payload = new Payload(agent.TELEGRAM, {});
            payload.setPayload(result);
            agent.add(payload);
        }
            
    }).catch(err => {
        console.log(`Error retrieving reminders: ${err}`);
        agent.add(`Failed to get reminders from the database. Please try again`);
    });
  }
  
  function rename(agent) {
    const name = agent.parameters.name;
    const oldName = agent.parameters.old_name;
    const userId = request.body.originalDetectIntentRequest.payload.data.message.from.id.toString();

    const remindersRef = db.collection('reminders').doc(userId);
    return db.runTransaction(t => {
        return t.get(remindersRef)
        .then(doc => {
            if (doc !== null) {
                if (!doc.exists) {
                    return Promise.reject('Such reminder does not exist');
                } else {
                    let reminders = doc.data.reminders || {};
                    let list = doc.data().reminders.filter(function(item) {
                        return item.text === oldName;
                    });
                        
                    if (list.length > 0) {
                        list.forEach(function(item, index) {
                            t.update(remindersRef, {
                                reminders: admin.firestore.FieldValue.arrayRemove({
                                    time: item.time,
                                    text: oldName,
                                    id: item.id
                                })
                            });
                            
                            if (typeof schedule.scheduledJobs[item.id] !== 'undefined') {
                                const job = schedule.scheduledJobs[item.id];
                                job.cancel();
                            }
                            
                            const dateObj = new Date(item.time);
                            const newId = name + dateObj.getTime();
                            
                            t.update(remindersRef, {
                                reminders: admin.firestore.FieldValue.arrayUnion({
                                    time: item.time,
                                    text: name,
                                    id: newId
                                })
                            });
                            
                            schedule.scheduleJob(newId, dateObj, function(text, time) {
                                agent.setFollowupEvent({
                                    name: "alert",
                                    languageCode: "en-US",
                                    parameters: {
                                        text: text,
                                        time: time
                                    },
                                });
                            }.bind(null, name, item.time));
                        });
                    } else {
                        return Promise.reject('Such reminder does not exist');
                    }
                }
            }
              
            return Promise.resolve('Done!');
        });
    }).then(result => {
        agent.add(result);
        console.log(`Write complete: ${result}`);
    }).catch(err => {
        console.log(`Error writing to Firestore: ${err}`);
        agent.add(`Failed to update reminder: ${err}`);
    });
  }
  
  function reschedule(agent) {
    let name = '';
    if ('name' in agent.parameters) {
         name = agent.parameters.name;
    }
    
    const time = typeof(agent.parameters.time) === 'object' ? agent.parameters.time.date_time : agent.parameters.time;
    const newTime = typeof(agent.parameters.time_new) === 'object' ? agent.parameters.time_new.date_time : agent.parameters.time_new;
    const userId = request.body.originalDetectIntentRequest.payload.data.message.from.id.toString();

    const remindersRef = db.collection('reminders').doc(userId);
    return db.runTransaction(t => {
        return t.get(remindersRef)
        .then(doc => {
            if (!doc.exists) {
                return Promise.reject('Such reminder does not exist');
            } else {
                let reminders = doc.data.reminders || {};
                let list = doc.data().reminders.filter(function(item) {
                    if (!name) {
                        return item.time === time;
                    }
                        return item.time === time && item.text === name;
                    });
                    
                    if (list.length > 0) {
                        list.forEach(function(item, index) {
                            t.update(remindersRef, {
                                reminders: admin.firestore.FieldValue.arrayRemove({
                                    time: time,
                                    text: item.text,
                                    id: item.id
                                })
                            });
                            
                            if (typeof schedule.scheduledJobs[item.id] !== 'undefined') {
                                const job = schedule.scheduledJobs[item.id];
                                job.cancel();
                            }
                            
                            const dateObj = new Date(newTime);
                            const newId = item.text + dateObj.getTime();
                            
                            t.update(remindersRef, {
                                reminders: admin.firestore.FieldValue.arrayUnion({
                                  time: newTime,
                                  text: item.text,
                                  id: newId
                                })
                            });
                            
                            schedule.scheduleJob(newId, dateObj, function(text, time) {
                                agent.setFollowupEvent({
                                    name: "alert",
                                    languageCode: "en-US",
                                    parameters: {
                                        text: text,
                                        time: time
                                    },
                                });
                            }.bind(null, item.text, newTime));
                        });
                    } else {
                        return Promise.reject('Such reminder does not exist');
                    }
                }
              
            return Promise.resolve('Done!');
        });
    }).then(result => {
        agent.add(result);
        console.log(`Write complete: ${result}`);
    }).catch(err => {
        console.log(`Error writing to Firestore: ${err}`);
        agent.add(`Failed to update reminder: ${err}`);
    });
  }
  
  function remove(agent) {
    let name = ''; 
    let time = '';  
      
    if ('time' in agent.parameters) {
        time = typeof(agent.parameters.time) === 'object' ? agent.parameters.time.date_time : agent.parameters.time;
    }
    
    if ('name' in agent.parameters) {
         name = agent.parameters.name;
    }
    
    const userId = request.body.originalDetectIntentRequest.payload.data.hasOwnProperty('message') ?
        request.body.originalDetectIntentRequest.payload.data.message.from.id.toString() : 
        request.body.originalDetectIntentRequest.payload.data.callback_query.from.id.toString();

    const remindersRef = db.collection('reminders').doc(userId);
    return db.runTransaction(t => {
        return t.get(remindersRef)
        .then(doc => {
            if (doc.exists) {
                let reminders = doc.data.reminders;
                let list = doc.data().reminders.filter(function(item) {
                    if (!name) {
                        return item.time === time;
                    } else if (!time) {
                        return  item.text === name;
                    }
                    
                    return item.time === time && item.text === name;
                });
                    
                if (list.length > 0) {
                    list.forEach(function(item, index) {
                        t.update(remindersRef, {
                            reminders: admin.firestore.FieldValue.arrayRemove({
                                time: item.time,
                                text: item.text,
                                id: item.id
                            })
                        });
                        
                        if (typeof schedule.scheduledJobs[item.id] !== 'undefined') {
                            const job = schedule.scheduledJobs[item.id];
                            job.cancel();
                        }
                    });
                }
            }

            return Promise.resolve('Done!');
        });
    }).then(result => {
        agent.add(result);
        console.log(`Write complete: ${result}`);
    }).catch(err => {
        console.log(`Error writing to Firestore: ${err}`);
        agent.add(`Failed to remove reminder: ${err}`);
    });
  }
  
  function displayAlert(agent) {
    const userId = request.body.originalDetectIntentRequest.payload.data.message.from.id.toString();
    const alertContext = request.body.queryResult.outputContexts.filter(function(value){
        return value.name.includes('alert');
    });
    const text = alertContext[0].parameters.text;
    const time = alertContext[0].parameters.time;
    
    const result = {
        "chat_id": userId,
        "text": `*${text}!!!*`,
        "parse_mode": "markdown",
        "reply_markup": {
            "inline_keyboard": [
                [
                    {
                        "text": "Snooze",
                        "callback_data": `Move ${text} at ${time.substr(0, 10)} ${time.substr(11, 5)}`
                    },
                    {
                        "text": "Confirm",
                        "callback_data": `Delete ${text} for ${time.substr(0, 10)} ${time.substr(11, 5)}`
                    }]]
        }
    };
        
    const payload = new Payload(agent.TELEGRAM, {});
    payload.setPayload(result);
    agent.add(payload);
  }
  
  function showReminder(agent) {
    const name = agent.parameters.text;
    const time = typeof(agent.parameters.time) === 'object' ? agent.parameters.time.date_time : agent.parameters.time;
    
    const reminderTime = new Date(time);
    const now = Date.now();
    const timeLeft = (reminderTime - now) / 60 / 60 / 1000;
    const details = timeLeft > 0 ? `Time left: ${timeLeft.toFixed(2)} h` : 'Status: past';
    
    agent.add(new Card({
        title: `Reminder details`,
        text: `Name: ${name}\nTime: ${time.substr(0, 10)} at ${time.substr(11, 5)}\n${details}`,
      })
    );
  }

  let intentMap = new Map();
  intentMap.set('Default Welcome Intent', welcome);
  intentMap.set('Default Fallback Intent', fallback);
  intentMap.set('Create', addReminder);
  intentMap.set('ShowReminders', showReminders);
  intentMap.set('Show reminder details', showReminder);
  intentMap.set('Rename', rename);
  intentMap.set('Reschedule', reschedule);
  intentMap.set('Remove', remove);
  intentMap.set('Alert', displayAlert);
  agent.handleRequest(intentMap);
});
