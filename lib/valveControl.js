'use strict';
/*
 info:  log aufbau valveControl.js: #2.*
 */

const myConfig = require('./myConfig.js');
const addTime = require('./tools.js').addTime;
const formatTime = require('./tools').formatTime;
const sendMessageText = require('./sendMessageText.js');            // sendMessageText

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
let adapter;

/**
 * Thread-list
 * => Auflistung aller aktiver Sprenger-Kreise
 * @type {array}
 */
const threadList = [];

/** @type {boolean} */
let boostReady = true,
    /** @type {boolean} */
    boostOn = false,
    /** @type {any | undefined} */
    boostListTimer,
    /**
     * maximal zulässige Anzahl der eingeschalteten Ventile
     * @type {number} */
    maxParallel,
    /* Control of the cistern pump */
    /** Füllstand der Zisterne
     *  @type {number}*/
    fillLevelCistern = 0,

    /** Schaltabstand zwischen den Ventilen
     *  @type {any | number | undefined} */
    switchingInterval = 300;




const currentPumpUse = {
    /**
     * Pumpen aktive?
     * @type {boolean} */
    enable: false,
    /**
     * Zisterne aktive?
     * @type {boolean} */
    pumpCistern: false,
    /**
     * Pumpen-Bezeichnung; z.B. "hm-rpc.0.MEQ1810129.1.STATE"
     * @type {string} */
    pumpName: '',
    /**
     * Pumpenleistung in l/h
     * @type {number}  */
    pumpPower: 0
}


/*==============================================================================================================================================*/

/**
 * Sprinkle (sprinkleName) delete
 * => Ventil (sprinkleName) löschen
 * @param {array.<{sprinkleName: string}>} killList
 */
function delList (killList) {
    for(const sprinkleName of killList) {
        let bValveFound = false;	// Ventil gefunden
        for(let counter = 0,                                  // Loop über das Array
                lastArray = (threadList.length - 1);     // entsprechend der Anzahl der Eintragungen
            counter <= lastArray;
            counter++) {
            const entry = threadList[counter].sprinkleName;
            if ((sprinkleName === entry) || bValveFound) {
                if (sprinkleName === entry) bValveFound = true;
                if (counter !== lastArray) threadList[counter] = threadList[counter + 1];
            }
        }
        /* If a valve is found, delete the last array (entry). Wenn Ventil gefunden letzten Array (Auftrag) löschen */
        if (bValveFound) {
            threadList.pop();
            if (adapter.config.debug) {
                adapter.log.info('#2.10 order deleted ID: ' + sprinkleName + ' ( rest orders: ' + threadList.length + ')');
            }
        }
    }

} // End delList

/*----------------------------------------------------------------------------------------------------------------------------------------------*/

/**
 * Activation of the booster (all other active valves are deactivated for the duration of the boost so that the sprinkler can be extended with the maximum possible pressure)
 * => aktivierung des Boosters (alle anderen aktiven Ventile werden für die Zeit des Boosts deaktiviert um den maximalen möglichen Druck zum Ausfahren der Sprenger zu ermöglichen)
 * @param {number} sprinkleID
 */
function boostList (sprinkleID) {
    boostReady = false;
    boostOn = true;
    for(const entry of threadList) {
        if (entry.enabled) {
            if (entry.sprinkleID === sprinkleID) {      // Booster
                /* Zustand des Ventils im Thread < 0 > off, < 1 > wait, < 2 > on, < 3 > break, <<< 4 >>> Boost(on), < 5 > off(Boost) */
                adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                    val: 4,
                    ack: true
                });
                //valveState(entry, 'Boost(on)');
                entry.times.boostTime2 = setTimeout(() => {
                    /* Zustand des Ventils im Thread < 0 > off, < 1 > wait, <<< 2 >>> on, < 3 > break, < 4 > Boost(on), < 5 > off(Boost) */
                    adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                        val: 2,
                        ack: true
                    });
                    entry.times.boostTime2 = null;
                },31000);
            } else {    // rest der Ventile
                // in die Zwangspause (myBreak = true)
                entry.times.boostTime1 = setTimeout(() => {
                    /* Zustand des Ventils im Thread < 0 > off, < 1 > wait, < 2 > on, < 3 > break, < 4 > Boost(on), <<< 5 >>> off(Boost) */
                    adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                        val: 5,
                        ack: true
                    });
                    entry.myBreak = true;
                    // valveOnOff(entry, false, '#2.1 Set: off(Boost), ID: ');
                    entry.times.boostTime1 = null;
                },250);
                // aus der Zwangspause holen (myBreak = false)
                entry.times.boostTime2 = setTimeout(() => {
                    /* Zustand des Ventils im Thread < 0 > off, < 1 > wait, <<< 2 >>> on, < 3 > break, < 4 > Boost(on), < 5 > off(Boost) */
                    adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                        val: 2,
                        ack: true
                    });
                    // valveOnOff(entry, true, '#2.2 Set: on, ID: ');
                    entry.myBreak = false;
                    entry.times.boostTime2 = null;
                },31000);
            }
        }
    }
    boostListTimer = setTimeout(() => {
        boostOn = false;
        updateList();
    },32000);
} // End boostList

/*----------------------------------------------------------------------------------------------------------------------------------------------*/

/**
 * If boostOn is ended by entering "runningTime = 0", normal operation should be restored. (Delete timer)
 * => Wenn boostOn über die Eingabe "runningTime = 0" beendet wird, so soll zum Normalen ablauf wieder zurückgekehrt werden. (Löschen der Timer)
 * @param {number} sprinkleID
 */
function boostKill (sprinkleID) {
    for(const entry of threadList) {
        if (entry.enabled) {
            if (entry.sprinkleID === sprinkleID) {
                /* booster wird gekillt */
                boostOn = false;
                if(entry.times.boostTime2) {
                    clearTimeout(entry.times.boostTime2);
                    entry.times.boostTime2 = null;
                }
            } else {
                /* normaler weiterbetrieb für den Rest */
                if (entry.times.boostTime1) {
                    clearTimeout(entry.times.boostTime1);
                    entry.times.boostTime1 = null;
                    if (adapter.config.debug) {
                        adapter.log.info('#2.11 ID: ' + entry.sprinkleName + ' => boostTime2 (Ende) gelöscht)');
                    }
                }
                if (entry.times.boostTime2) {
                    clearTimeout(entry.times.boostTime2);
                    entry.times.boostTime2 = null;
                    /* Zustand des Ventils im Thread < 0 > off, < 1 > wait, <<< 2 >>> on, < 3 > break, < 4 > Boost(on), < 5 > off(Boost) */
                    adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                        val: 2,
                        ack: true
                    });
                    // valveOnOff(entry, true, '#2.3 Set: on, ID: ');
                }
            }
        }
    }
} // End boostKill

/*----------------------------------------------------------------------------------------------------------------------------------------------*/

/**
 * Schaltintervall der Ventile, Soll in der Config hinterlegt werden
 * @returns {Promise<unknown>}
 */
const valveDelay = () => {
    return new Promise (
        resolve => setTimeout (resolve, switchingInterval)
    )
};
/**
 * Ausschalten der Ventile mit Schaltabstand
 * @param {array} threadList  Auflistung aller aktiver Sprenger-Kreise
 * @param {number} parallel  aktuelle Anzahl der eingeschalteten Ventile
 * @returns {Promise<void>}
 */
const switchTheValvesOffOn = async (threadList, parallel) => {
    /**Sammlung von .sprinkleName die am Ende von updateList gelöscht werden
     *  @type {array} - */
    let killList = [];
    for (const entry of threadList) {               // ausschalten der Ventile
        if ((!entry.enabled                             // ( Ventile ausgeschaltet z.B. Intervall-Beregnung
            || entry.enabled && entry.myBreak           //      || in Pause z.B. Boost
            || entry.killSprinkle)                      //      || Bewässerung erledigt )
            && entry.enabled !== entry.enabledState     // && Ventil nicht aktuell
        ) {
            adapter.setForeignState(entry.idState, {
                val: false,
                ack: false
            }, (err) => {
                if (err) {
                    return err;
                } else {
                    adapter.log.info('#2.06 Set (false) ID: ' + entry.sprinkleName + ', value: ' + entry.enabled);
                }
            });
            entry.enabledState = entry.enabled;
            /* Ventil aus threadList löschen => Aufgabe beendet und nicht in der Pause sind */
            if (entry.killSprinkle) {
                killList.push(entry.sprinkleName);
            }
            await valveDelay ();
        }
    }
    if (currentPumpUse.pumpName !== '') {
        setPumpOnOff(parallel > 0);
        await valveDelay ();
    }
    if (adapter.config.triggerControlVoltage) {
        setVoltageOnOff(parallel>0);
        await valveDelay ();
    }


    for (const entry of threadList) {                   // einschalten der Ventile
        if (entry.enabled                                   // intern eingeschaltet
            && !entry.myBreak                               // && keine Pause
            && !entry.killSprinkle                          // Bewässerung noch nicht erledigt
            && entry.enabled !== entry.enabledState         // && Ventil nicht aktuell
        ) {
            adapter.setForeignState(entry.idState, {
                val: true,
                ack: false
            }, (err) => {
                if (err) {
                    return err;
                } else {
                    adapter.log.info('#2.05 Set (true) ID: ' + entry.sprinkleName + ', value: ' + entry.enabled);
                }
            });
            entry.enabledState = entry.enabled;
            await valveDelay ();
        }
    }

    delList(killList);              // erledigte Bewässerungsaufgaben aus der threadList löschen
};

/*----------------------------------------------------------------------------------------------------------------------------------------------*/

/**
 * Control of the active irrigation circuits so that the maximum pump capacity (l / h) is achieved and the maximum number of irrigation circuits is not exceeded.
 * => Steuerung der aktiven Bewässerungskreise, damit die maximale Pumpenkapazität (l / h) erreicht wird und die maximale Anzahl der Bewässerungskreise nicht überschritten wird.
 */
function updateList () {
    /* während des Boost eines Kreises ist ein zuschalten von Sprengern nicht möglich */
    if (boostOn) {return;}

    /**
     * aktuelle Rest-Pumpenleistung
     * @type {number}
     */
    let curFlow = currentPumpUse.pumpPower, /* adapter.config.triggerMainPumpPower; */
        /**
         * aktuelle Anzahl der eingeschalteten Ventile
         * @type {number}
         */
        parallel = 0;

    /**
     * Sortierfunktion mySortDescending absteigende Sortierung
     * @param a
     * @param b
     * @returns {number}
     */
    function mySortDescending(a, b) {
        return a.pipeFlow > b.pipeFlow ? -1 :
            a.pipeFlow < b.pipeFlow ? 1 :
                0;
    }
    /**
     * Sortierfunktion mySortAscending aufsteigende Sortierung
     * @param a
     * @param b
     * @returns {number}
     */
    function mySortAscending(a, b) {
        return a.pipeFlow < b.pipeFlow ? -1 :
            a.pipeFlow > b.pipeFlow ? 1 :
                0;
    }
    /**
     * Handling von Ventilen, Zeiten, Verbrauchsmengen im 1s Takt
     * @param {object} entry
     */
    function countSprinkleTime(entry) {
        /* --- function beenden wenn ---*/
        if (boostOn && !(myConfig.config[entry.sprinkleID].booster)   // boost-On && kein aktuelles Boost-Ventil
        ) {
            return;
        }
        entry.count ++;
        if ((entry.count < entry.wateringTime)	// Zeit noch nicht abgelaufen?
            && ((myConfig.config[entry.sprinkleID].soilMoisture.val < myConfig.config[entry.sprinkleID].soilMoisture.maxIrrigation)		// Bodenfeuchte noch nicht erreicht? (z.B. beim Regen)
                || !entry.autoOn)	// Vergleich nur bei Automatik
        ) {     /* zeit läuft */
            adapter.setState('sprinkle.' + entry.sprinkleName + '.countdown', {
                val: addTime(entry.wateringTime - entry.count, ''),
                ack: true
            });
            /* Alle 15s die Bodenfeuchte anpassen */
            if (!(entry.count % 15)) {	// alle 15s ausführen
                myConfig.addSoilMoistVal(entry.sprinkleID, entry.soilMoisture15s);
            }
            /* Intervall-Beregnung wenn angegeben (onOffTime > 0) */
            if ((entry.onOffTime > 0) && !(entry.count % entry.onOffTime)) {
                entry.enabled = false;
                entry.myBreak = true;
                /* Zustand des Ventils im Thread < 0 > off, < 1 > wait, < 2 > on, <<< 3 >>> break, < 4 > Boost(on), < 5 > off(Boost) */
                adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                    val: 3,
                    ack: true
                });
                // valveOnOff(entry, false, '#2.4 Set: break, ID: ');
                updateList();
                clearInterval(entry.countdown);
                entry.onOffTimeoutOff = setTimeout(()=>{
                    entry.myBreak = false;
                    /* Zustand des Ventils im Thread < 0 > off, <<< 1 >>> wait, < 2 > on, < 3 > break, < 4 > Boost(on), < 5 > off(Boost) */
                    adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                        val: 1,
                        ack: true
                    });
                    updateList();
                },1000 * entry.onOffTime);
            }
        } else {    /* zeit abgelaufen => Ventil ausschalten */
            /* Zustand des Ventils im Thread <<< 0 >>> off, < 1 > wait, < 2 > on, < 3 > break, < 4 > Boost(on), < 5 > off(Boost) */
            entry.enabled = false;
            adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                val: 0,
                ack: true
            });
            adapter.setState('sprinkle.' + entry.sprinkleName + '.runningTime', {
                val: 0,
                ack: true
            });
            adapter.setState('sprinkle.' + entry.sprinkleName + '.countdown', {
                val: 0,
                ack: true
            });

            // valveOnOff(entry, false, '#2.5 Set: off, ID: ');
            /* Wenn in der Konfiguration Bodenfeuchte = 100% gesetzt ist und Auto-Bewässerung aktive, dann Bodenfeuchte = 100% setzen*/
            if (entry.autoOn && myConfig.config[entry.sprinkleID].endIrrigation) {
                myConfig.setSoilMoistPct100(entry.sprinkleID);
            }
            /* Verbrauchswerte in der Historie aktualisieren */
            addConsumedAndTime(entry);
            /* Booster zurücksetzen */
            if (myConfig.config[entry.sprinkleID].booster) {
                if (boostOn) {boostKill(entry.sprinkleID);}
                boostReady = true;
                if (adapter.config.debug) {
                    adapter.log.info('#2.12 ID: ' + entry.sprinkleName + 'UpdateList Sprinkle Off: boostReady = ' + boostReady);
                }
            }
            /* Zeiten löschen */
            clearInterval(entry.countdown);
            /*clearTimeout(entry.onOffTimeoutOn);*/
            clearTimeout(entry.onOffTimeoutOff);
            /* Ventil aus threadList löschen => Aufgabe beendet */
            //delList(entry.sprinkleName);
            entry.killSprinkle = true;
            updateList();
        }
    }

    // ermitteln von curPipe und der anzahl der parallelen Stränge
    for(const entry of threadList){
        if (entry.enabled && !entry.killSprinkle) {
            curFlow -= entry.pipeFlow;	// // ermitteln der RestFörderkapazität
            parallel ++;	// Anzahl der Bewässerungsstellen um 1 erhöhen
        }
    }

    if (curFlow < 0) {
        /* - wenn beim Umschalten der Pumpen die Förderleistung zu gering => Ventile deaktivieren - */
        // aufsteigend sortieren nach der Verbrauchsmenge
        threadList.sort(mySortAscending);

        for(const entry of threadList) {
            if (entry.enabled                   //  eingeschaltet
                && !entry.killSprinkle          //  && Aufgabe noch nicht erledigt
                && (curFlow < 0)
            ) {                             //  && Förderleistung der Pumpe zu gering
                entry.enabled = false;          // ausgeschaltet merken
                clearInterval(entry.countdown); // Zähler für Countdown, Verbrauchsmengen, usw. löschen
                curFlow += entry.pipeFlow;	    // ermitteln der RestFörderkapazität
                parallel--;	                    // Anzahl der Bewässerungsstellen um 1 verringern
                /* Zustand des Ventils im Thread < 0 > off, <<< 1 >>> wait, < 2 > on, < 3 > break, < 4 > Boost(on), < 5 > off(Boost) */
                adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                    val: 1,
                    ack: true
                });
                // valveOnOff(entry, false, '#2.6 Set: wait, ID: ');
                adapter.log.info('#2.07 Set ID: ' + entry.sprinkleName + ' Pump delivery rate too low, wait!  curFlow ' + curFlow + ' parallel: ' + parallel);
            }
        }
    }

    // absteigend sortieren nach der Verbrauchsmenge
    threadList.sort(mySortDescending);

    // einschalten der Bewässerungsventile nach Verbrauchsmenge und maximaler Anzahl
    for(const entry of threadList) {
        if (!entry.enabled                                                      // ausgeschaltet
            && !entry.killSprinkle                                              // && Aufgabe noch nicht erledigt
            && !entry.myBreak                                                   // && nicht in der Pause
            && (curFlow >= entry.pipeFlow)                                      // && noch genügend Förderleistung der Pumpe
            && (parallel < maxParallel)                                         // && maxParallel noch nicht erreicht
            && ((boostReady) || !(myConfig.config[entry.sprinkleID].booster))   // nur einer mit boostFunction darf aktive sein
        ) {
            entry.enabled = true;	// einschalten merken
            if (myConfig.config[entry.sprinkleID].booster) {
                boostReady = false;
                if (adapter.config.debug) {
                    adapter.log.info('#2.13 ID: ' + entry.sprinkleName + 'UpdateList sprinkle On: boostReady = ' + boostReady);
                }
                setTimeout(() => {
                    boostList(entry.sprinkleID);
                }, 50);
            }
            curFlow -= entry.pipeFlow;	// ermitteln der RestFörderkapazität
            parallel++;	// Anzahl der Bewässerungsstellen um 1 erhöhen
            /* Zustand des Ventils im Thread < 0 > off, < 1 > wait, <<< 2 >>> on, < 3 > break, < 4 > Boost(on), < 5 > off(Boost) */
            adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                val: 2,
                ack: true
            });
            // valveOnOff(entry, true, '#2.7 Set: on, ID: ');
            /* countdown starten */
            if (!entry.startTime) {
                entry.startTime = new Date();
            }
            entry.countdown = setInterval(() => {
                countSprinkleTime(entry);
            }, 1000);	// 1000 = 1s

        }
    }

    adapter.setState('control.parallelOfMax', {
        val: parallel + ' : ' + maxParallel,
        ack: true
    });
    adapter.setState('control.restFlow', {
        val: '' + curFlow + ' (' + currentPumpUse.pumpPower + ' ' + (currentPumpUse.pumpCistern ? 'Zisterne' : 'Grundwasser')  + ')',
        ack: true
    });

    switchTheValvesOffOn(threadList, parallel).then(err => {
        if (err) {
            adapter.log.error('#Error - Set (false) err: ' + err);
            sendMessageText.sendMessage('Error - Set (fase) err: ' + err);
        }
    });
} // End updateList

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

/**
 * +++++  Set the current pump for irrigation  +++++
 * => Festlegen der aktuellen Pumpe zur Bewässerung
 */
function setActualPump () {
    if (adapter.config.cisternSettings === true) {
        /* Zisternen-Bewässerung Einstellung in der config (2.Pumpe) aktiviert */
        if (currentPumpUse.enable === true) {
            /* Bewässerungspumpen aktiv */
            if ((fillLevelCistern < parseFloat(adapter.config.triggerMinCisternLevel)) && (currentPumpUse.pumpCistern === true)) {
                /* (Zisterne unter Minimum) && (ZisternenPumpe läuft) */
                adapter.setForeignState(currentPumpUse.pumpName, {
                    val: false,
                    ack: false
                }); // Pumpe Zisterne Aus
                currentPumpUse.pumpCistern = false;
                currentPumpUse.pumpName = adapter.config.triggerMainPump || '';
                currentPumpUse.pumpPower = parseInt(adapter.config.triggerMainPumpPower);
                adapter.setForeignState(currentPumpUse.pumpName, {
                    val: true,
                    ack: false
                }); // Hauptpumpe Ein
                adapter.log.info('#2.08 Pump change (cistern empty) Cistern pump off => main pump on');
                updateList();   // Wasserverbrauch an Pumpenleistung anpassen
            }
            if (fillLevelCistern < parseFloat(adapter.config.triggerMinCisternLevel)) {
                adapter.setState('info.cisternState', {
                    val: 'Cistern empty: ' + fillLevelCistern + ' %  (' + adapter.config.triggerMinCisternLevel + ' %)',
                    ack: true
                });
            } else {
                adapter.setState('info.cisternState', {
                    val: 'Cistern filled: ' + fillLevelCistern + ' %  (' + adapter.config.triggerMinCisternLevel + ' %)',
                    ack: true
                });
            }
        } else {
            /* Bewässerungspumpen inaktiv */
            if ((fillLevelCistern > parseFloat(adapter.config.triggerMinCisternLevel)) && (adapter.config.triggerCisternPump) && (adapter.config.triggerCisternPumpPower)) {
                /* Zisterne voll && triggerCisternPump && triggerCisternPumpPower vorhanden*/
                adapter.setState('info.cisternState', {
                    val: 'Cistern filled: ' + fillLevelCistern + ' %  (' + adapter.config.triggerMinCisternLevel + ' %)',
                    ack: true
                });
                currentPumpUse.pumpCistern = true;
                currentPumpUse.pumpName = adapter.config.triggerCisternPump || '';
                currentPumpUse.pumpPower = parseInt(adapter.config.triggerCisternPumpPower);
                adapter.setState('control.restFlow', {
                    val: currentPumpUse.pumpPower + ' (' + currentPumpUse.pumpPower + ' Zisterne)',
                    ack: true
                });
            } else {
                adapter.setState('info.cisternState', {
                    val: 'Cistern empty: ' + fillLevelCistern + ' %  (' + adapter.config.triggerMinCisternLevel + ' %)',
                    ack: true
                });
                currentPumpUse.pumpCistern = false;
                currentPumpUse.pumpName = adapter.config.triggerMainPump || '';
                currentPumpUse.pumpPower = parseInt(adapter.config.triggerMainPumpPower);
                adapter.setState('control.restFlow', {
                    val: currentPumpUse.pumpPower + ' (' + currentPumpUse.pumpPower + ' Grundwasser)',
                    ack: true
                });
            }
        }
    } else {
        /* Pumpe AUS => Zisternen-Bewässerung nicht aktiviert */
        if (adapter.config.triggerCisternPump) {
            adapter.setState('info.cisternState', {
                val: 'Cistern settings are not active!' + ((fillLevelCistern > 0)?(' level sensor: ' + fillLevelCistern + '%' + ((adapter.config.triggerMinCisternLevel !== '')?('  (' + adapter.config.triggerMinCisternLevel + '%)'):(''))):('')),
                ack: true
            });
        }
    }
}   // End setActualPump

    /**
     * Switching the pump on or off
     * => Ein bzw. ausschaltern der Pumpe
     * @param {boolean} pumpOnOff ; Pumpe on = true
     */
function setPumpOnOff(pumpOnOff) {
    if (currentPumpUse.pumpName !== '') {
        adapter.getForeignState(currentPumpUse.pumpName, (err, state) => {
            if (state) {
                if (pumpOnOff) {
                    if (state.val === false) {
                        adapter.setForeignState(currentPumpUse.pumpName, {
                            val: true,
                            ack: false
                        });
                        currentPumpUse.enable = true;
                        adapter.log.info('#2.01 Set pump on');
                    }
                } else {
                    if (state.val !== false) {
                        adapter.setForeignState(currentPumpUse.pumpName, {
                            val: false,
                            ack: false
                        });
                        currentPumpUse.enable = false;
                        adapter.log.info('#2.02 Set pump off');
                    }
                }
            } else if (err) {
                adapter.log.error('#2.17 triggerMainPump ' + currentPumpUse.pumpName + ' is not available (ist nicht erreichbar): ' + err);
            }
        });
    }
}   // End setPumpOnOff

/**
 * Switching the control voltage on or off
 * => Ein bzw. ausschaltern der Steuerspannung
 * @param {boolean} voltageOnOff - Voltage on = true
 */
function setVoltageOnOff(voltageOnOff) {
    if (adapter.config.triggerControlVoltage !== '') {
        adapter.getForeignState(adapter.config.triggerControlVoltage, (err, state) => {
            if (state) {
                if (voltageOnOff) {
                    if (state.val === false) {
                        adapter.setForeignState(adapter.config.triggerControlVoltage, {
                            val: true,
                            ack: false
                        });
                        adapter.log.info('#2.03 Set voltage on');
                    }
                } else {
                    if (state.val !== false) {
                        adapter.setForeignState(adapter.config.triggerControlVoltage, {
                            val: false ,
                            ack: false
                        });
                        adapter.log.info('#2.04 Set voltage off');
                    }
                }
            } else if (err) {
                adapter.log.error('#2.13 triggerControlVoltage is not available (ist nicht erreichbar): ' + err);
            }
        });
    }
}

/**
 * Adding the consumption data to the history
 * => Hinzufügen der Verbrauchsdaten zur History
 * @param entry - array mit den Daten des aktiven Ventils
 */
function addConsumedAndTime(entry) {
    adapter.setState('sprinkle.' + entry.sprinkleName + '.history.lastConsumed', {
        val: Math.round(entry.litersPerSecond * entry.count),
        ack: true
    });
    adapter.setState('sprinkle.' + entry.sprinkleName + '.history.lastRunningTime', {
        val: addTime(entry.count, ''),
        ack: true
    });
    adapter.setState('sprinkle.' + entry.sprinkleName + '.history.lastOn', {
        val: formatTime(adapter, entry.startTime, 'dd.mm. hh:mm'),
        ack: true
    });
    adapter.getState('sprinkle.' + entry.sprinkleName + '.history.curCalWeekConsumed', (err, state) => {
        if (state) {
            adapter.setState('sprinkle.' + entry.sprinkleName + '.history.curCalWeekConsumed', {
                val: (state.val) + Math.round(entry.litersPerSecond * entry.count),
                ack: false
            });
        }
    });
    adapter.getState('sprinkle.' + entry.sprinkleName + '.history.curCalWeekRunningTime', (err, state) => {
        if (state) {
            adapter.setState('sprinkle.' + entry.sprinkleName + '.history.curCalWeekRunningTime', {
                val: addTime(state.val, entry.count),
                ack: true
            });
        }
    });
}   // End addConsumedAndTime



/*----------------------------------------------------------------------------------------------------------------------------------------------*/

/*++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++*/
/*                                                       externe Funktionen                                                                     */
/*++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++*/

/**
 *
 * @type {{clearEntireList: valveControl.clearEntireList, initValveControl: valveControl.initValveControl, setFillLevelCistern: valveControl.setFillLevelCistern, addList: valveControl.addList}}
 */
const valveControl = {
    /**
     * Initialize the start configuration of ventilControl
     * => Initialisieren Sie die Startkonfiguration von ventilControl
     * @param {ioBroker.Adapter} myAdapter
     */
    initValveControl: (myAdapter) => {
        adapter = adapter || myAdapter;
        currentPumpUse.pumpCistern = false;
        currentPumpUse.pumpName = adapter.config.triggerMainPump || '';
        currentPumpUse.pumpPower = parseInt(adapter.config.triggerMainPumpPower) || 0;
        maxParallel = parseInt(adapter.config.maximumParallelValves);
        /* Objekt control.restFlow befüllen */
        adapter.setState('control.restFlow', {
            val: currentPumpUse.pumpPower + ' (' + currentPumpUse.pumpPower + ' ' + (currentPumpUse.pumpCistern ? 'Zisterne' : 'Grundwasser') + ')',
            ack: true
        });
        /* Objekt control.parallelOfMax befüllen */
        adapter.setState('control.parallelOfMax', {
            val: 0 + ' : ' + adapter.config.maximumParallelValves,
            ack: true
        });
        /* Pumpe ausschalter wenn vorhanden */
        if (adapter.config.triggerMainPump !== '') {
            adapter.getState('adapter.config.triggerMainPump', (err, state) => {
                if (state) {
                    adapter.setState(adapter.config.triggerMainPump, {
                        val: false,
                        ack: false
                    });
                }
            });
        }
        /* Pumpe (Zisterne) ausschalter wenn vorhanden */
        if (adapter.config.triggerCisternPump !== '') {
            adapter.getState('adapter.config.triggerCisternPump', (err, state) => {
                if (state) {
                    adapter.setState(adapter.config.triggerCisternPump, {
                        val: false,
                        ack: false
                    });
                }
            });
        }
        /* alle Ventile (.name = "hm-rpc.0.MEQ1234567.3.STATE") in einem definierten Zustand (false) versetzen*/
        const result = adapter.config.events;
        if (result) {
            for(const res of result) {
                adapter.getState(res.name, (err, state) => {
                    if (state) {
                        adapter.setState(res.name, {
                            val: false,
                            ack: false
                        });
                    }
                });
            }
        }
    },  // End initValveControl

    /**
     *  Add Sprinkle
     * => Sprinkle hinzufügen
     * @param {Array.<{autoOn: Boolean, sprinkleID: Number, wateringTime: Number}>} sprinkleList
     */
    addList: (sprinkleList) => {
        //
        for (const res of sprinkleList) {
            const sprinkleName = myConfig.config[res.sprinkleID].objectName;
            /**
             * add done
             * => hinzufügen erledigt (Sprenger bereits aktive)
             * @type {boolean}
             */
            let addDone = false;
            // schauen ob der Sprenger schon in der threadList ist
            if (threadList) {
                for (const entry of threadList) {
                    if (entry.sprinkleID === res.sprinkleID) {
                        if (entry.wateringTime === res.wateringTime) {
                            // adapter.setState('sprinkle.' + sprinkleName + '.runningTime', {val: addTime(wateringTime, ''), ack: false});
                            return;
                        }
                        entry.wateringTime = res.wateringTime;
                        entry.autoOn = res.autoOn;      // autoOn: = true autostart; = false Handbetrieb
                        adapter.setState('sprinkle.' + sprinkleName + '.runningTime', {
                            val: addTime(res.wateringTime, ''),
                            ack: false
                        });
                        addDone = true;		// Sprinkle found
                        if (adapter.config.debug) {
                            adapter.log.info('#2.14 update ID: ' + entry.sprinkleName + ' new time: ' + addTime(res.wateringTime, ''));
                        }
                        break;
                    }
                }
            }

            if (!addDone) {
                if (res.wateringTime <= 0) {
                    adapter.setState('sprinkle.' + sprinkleName + '.runningTime', {
                        val: '0',
                        ack: true
                    });
                    return;
                }
                const newThread = {};
                /** @type {number} */   newThread.sprinkleID = res.sprinkleID;	// Array[0...]
                /** @type {string} */   newThread.sprinkleName = sprinkleName;	// z.B "Blumenbeet"
                /** @type {string} */   newThread.idState = myConfig.config[res.sprinkleID].idState;	// z.B. "hm-rpc.0.MEQ1810129.1.STATE"
                /** @type {number} */   newThread.wateringTime = res.wateringTime;  // Bewässerungszeit
                /** @type {number} */   newThread.pipeFlow = myConfig.config[res.sprinkleID].pipeFlow;  // Wasserverbrauch
                /** @type {number} */   newThread.count = 0;                // Zähler im Sekundentakt
                /** @type {boolean} */  newThread.enabled = false;          // Ventil softwaremäßig ein
                /** @type {boolean} */  newThread.enabledState = false;     // Ventil hardwaremäßig ein
                /** @type {boolean} */  newThread.myBreak = false;          // meine Pause
                /** @type {boolean} */  newThread.killSprinkle = false;             // Löschauftrag ausführen am Ende in threadList
                /** @type {number} */   newThread.litersPerSecond = myConfig.config[res.sprinkleID].pipeFlow / 3600;    // Wasserverbrauchsmenge pro Sekunde
                /** @type {number} */   newThread.onOffTime = myConfig.config[res.sprinkleID].wateringInterval;
                /** @type {boolean} */  newThread.autoOn = res.autoOn;
                /** @type {number} */   newThread.soilMoisture15s = 15 * (myConfig.config[res.sprinkleID].soilMoisture.maxIrrigation - myConfig.config[res.sprinkleID].soilMoisture.triggersIrrigation)
                    / (60 * myConfig.config[res.sprinkleID].wateringTime);
                /** @type {any} */      newThread.times = [];       // hinterlegen der verschiedenen Zeiten von timeout für gezieltes späteres löschen
                /** @type {any} */      newThread.times.boostTime1 = null;  // boost start
                /** @type {any} */      newThread.times.boostTime2 = null;  // boost ende
                /** @type {number} */   newThread.id = threadList.length || 0;
                threadList.push(newThread);
                /* Zustand des Ventils im Thread < 0 > off, <<< 1 >>> wait, < 2 > on, < 3 > break, < 4 > Boost(on), < 5 > off(Boost) */
                adapter.setState('sprinkle.' + sprinkleName + '.sprinklerState', {
                    val: 1,
                    ack: true
                });
                adapter.setState('sprinkle.' + sprinkleName + '.runningTime', {
                    val: addTime(res.wateringTime, ''),
                    ack: false
                });
                if (adapter.config.debug) {
                    adapter.log.info('#2.15 ID: ' + sprinkleName + 'new order created: ' + JSON.stringify(threadList[newThread.id]));
                }
            }
        }
        updateList();
    }, // End addList

    /**
     * switch off all devices, when close the adapter
     * => Beim Beenden des adapters alles ausschalten
     */
    clearEntireList: () => {
        if (boostListTimer) {
            clearTimeout(boostListTimer);
        }
        // let bValveFound = false;	// Ventil gefunden
        for (let counter = threadList.length - 1;	// Loop über das Array
             counter >= 0;
             counter--) {
            const entry = threadList[counter];
            /* Zustand des Ventils im Thread <<< 0 >>> off, < 1 > wait, < 2 > on, < 3 > break, < 4 > Boost(on), < 5 > off(Boost) */
            adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', {
                val: 0,
                ack: true
            });
            adapter.setState('sprinkle.' + entry.sprinkleName + '.runningTime', {
                val: 0,
                ack: true
            });
            adapter.setState('sprinkle.' + entry.sprinkleName + '.countdown', {
                val: 0,
                ack: true
            });
            // valveOnOff(myEntry, false, '#2.0 Set: off, ID: ');
            /* Verbrauchswerte in der Historie aktualisieren */
            addConsumedAndTime(entry);
            /* del timer countdown */
            clearInterval(entry.countdown);
            /* del timer onOffTimeoutOff */
            clearTimeout(entry.onOffTimeoutOff);
            /* del timer newThread.times.boostTime1 */
            if (entry.times.boostTime1) {
                clearTimeout(entry.times.boostTime1);
                entry.times.boostTime1 = null;
            }
            /* del timer newThread.times.boostTime2 */
            if (entry.times.boostTime2) {
                clearTimeout(entry.times.boostTime2);
                entry.times.boostTime2 = null;
            }
            threadList.pop();
            if (adapter.config.debug) {
                adapter.log.info('#2.16 order deleted Stop all ID: ' + entry.sprinkleName + ' ( rest orders: ' + threadList.length + ')');
            }
        }
        updateList();
    }, // End clearEntireList

    /**
     * Änderungen des Füllstands setzen + Vorrang der Pumpe setzen
     * @param {number} levelCistern
     */
    setFillLevelCistern: (levelCistern) => {
        fillLevelCistern = (typeof levelCistern === 'number') ? levelCistern : 0 ;
        setActualPump();
    }   // End setFillLevelCistern
};  // End valveControl

/*++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++*/

module.exports = valveControl;