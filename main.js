'use strict';

// Load your modules here, e.g.: => // Laden Sie Ihre Module hier, z.B.
// const fs = require("fs");

const utils = require('@iobroker/adapter-core');
const schedule  = require('node-schedule');
const SunCalc = require('suncalc2');


/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
 
let adapter;
const adapterName = require('./package.json').name.split('.').pop();

/** @type {string} */
let todaysStartTime;
/** @type {string} */
let sunriseStr;
/** @type {string} */
let goldenHourEnd;
/** @type {string} */
let maxSunshine;	//Sonnenscheindauer in Stunden)
/** @type {any} */
let HolidayStr;
/** @type {any} */
let autoOnOffStr;
/** @type {any} */
let publicHolidayStr;
/** @type {any} */
let publicHolidayTomorowStr;
/** @type {any} */
let startTime;
let dayStr;	// 0..6 0 = Sonntag
let kwStr; // akt. KW der Woche
// calcEvaporation
	let curTemperature;		/*Temperatur*/
	let curHumidity;		/*LuftFeuchtigkeit*/
	let curIllumination;	/*Helligkeit*/
	let curWindSpeed;		/*WindGeschwindigkeit*/
	let lastRainCounter = 0;		/*last rain container => letzter Regenkontainer*/
	let curAmountOfRain = 0;	/*current amount of rain => aktuelle Regenmenge*/
	let lastChangeEvaPor;	/*letzte Aktualisierungszeit*/
let ObjSprinkle = [];
let resObjektName = [];
let resActSoilMoisture = [];
let resRunningTime =[]; /* Laufzeit der Ventile in den Objekten */

/**
 * Starts the adapter instance
 * @param {Partial<ioBroker.AdapterOptions>} [options]
 */
//
const ObjThread = {
	threadList: [],
	addList : function (sprinkleName, name, wateringTime, pipeFlow, onOffTime) {
		let addDone = false;
		if (ObjThread.threadList) {
			for(let entry of ObjThread.threadList) {
				if (entry.sprinkleName == sprinkleName) {
					if (entry.wateringTime == parseInt(wateringTime)) {return;}
					entry.wateringTime = parseInt(wateringTime);
					adapter.setState('sprinkle.' + sprinkleName + '.runningTime', {val: addTime(wateringTime), ack: false});
					addDone = true;
					break;
				}
			}
		}
		
		if (!addDone) {
			if (parseInt(wateringTime) <= 0) return;
			let newThread = [];
			newThread.sprinkleName = sprinkleName;	// z.B "Blumenbeet"
			newThread.name = name;	// z.B. "hm-rpc.0.MEQ1810129.1.STATE"
			newThread.wateringTime = parseInt(wateringTime);
			newThread.pipeFlow = parseInt(pipeFlow);
			newThread.count = 0;
			newThread.enabled = false;
			newThread.myBreak = false;
			newThread.litersPerSecond = pipeFlow / 3600;
			newThread.onOffTime = (parseInt(onOffTime) || 0);
			newThread.id = ObjThread.threadList.length || 0;			
			ObjThread.threadList.push(newThread);
			adapter.setState('sprinkle.' + sprinkleName + '.sprinklerState', {val: 1, ack: false });	// Zustand des Ventils im Thread < 0 > Aus, <<< 1 >>> warten, < 2 > Active, < 3 > Pause
			adapter.setState('sprinkle.' + sprinkleName + '.runningTime', {val: addTime(wateringTime), ack: false});
		}
	}, // End addList
	
	delList : function (sprinkleName) {
		let bValveFound = false;	// Ventil gefunden
		for (var zaehler = 0,                                  // Loop über das Array
			lastArray = (ObjThread.threadList.length - 1);             // entsprechend der Anzahl der Eintragungen
			zaehler <= lastArray;
			zaehler++) {
			let entry = ObjThread.threadList[zaehler].sprinkleName;
			if ((sprinkleName == entry) || bValveFound) {
				if (sprinkleName == entry) bValveFound = true;
				if (zaehler != lastArray) ObjThread.threadList[zaehler] = ObjThread.threadList[zaehler + 1];
			}
        }
		
		if (bValveFound) {
			ObjThread.threadList.pop();
			adapter.log.info(sprinkleName + ' !!! >>> wurde gelöscht');		
		}    // Wenn Ventil gefunden letzten Arrey (Auftrag) löschen
	
		ObjThread.updateList();
	
	}, // End delList
	
	updateList : function () {
		let curFlow = adapter.config.triggerMainPumpPower;
		let parallel = 0;
		let maxParallel = adapter.config.maximumParallelValves;
	    // Sortierfunktion mySort absteigende Sortierung 
		function mySort(a, b) {
			return a.pipeFlow > b.pipeFlow ? -1 :
				a.pipeFlow < b.pipeFlow ? 1 :
					0;
		}
		// ermitteln von curPipe und der anzahl der parallelen Stränge
		for(let entry of ObjThread.threadList){
			if (entry.enabled) {
				curFlow -= entry.pipeFlow;	// // ermitteln der RestFörderkapazität
				parallel ++;	// Anzahl der Bewässerungsstellen um 1 erhöhen
			}
		}

		ObjThread.threadList.sort(mySort);     // sortieren nach der Verbrauchsmenge
		
		// einschalten der Sprängerventile nach Verbrauchsmenge und maximaler Anzahl
		for(let entry of ObjThread.threadList) {
			if (!entry.enabled && !entry.myBreak && (curFlow >= entry.pipeFlow) && (parallel < maxParallel)) {
				entry.enabled = true;	// einschalten merken
				curFlow -= entry.pipeFlow;	// ermitteln der RestFörderkapazität
				parallel ++;	// Anzahl der Bewässerungsstellen um 1 erhöhen
				adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', { val: 2, ack: true });	// Zustand des Ventils im Thread < 0 > Aus, < 1 > warten, <<< 2 >>> Active, < 3 > Pause
				// adapter.setForeignState(entry.name, {val: true, ack: false});	// Ventil einschalten
				/*if (entry.onOffTime > 0) {
					entry.onOffTimeoutOn = setTimeout(()=>{
						entry.enabled = false;
						entry.myBreak = true;
						adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', { val: 3, ack: true});	// Zustand des Ventils im Thread <<< 0 >>> Aus, < 1 > warten,
						ObjThread.updateList();
						clearInterval(entry.countdown);
						entry.onOffTimeoutOff = setTimeout(()=>{
							entry.myBreak = false;
							adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', { val: 1, ack: true});	// Zustand des Ventils im Thread <<< 0 >>> Aus, < 1 > warten,
							ObjThread.updateList();
						},entry.onOffTime);
					}, entry.onOffTime);
				}*/
				// countdown starten
				if (!entry.startTime) {entry.startTime = new Date();}
				entry.countdown = setInterval(() => {countSprinkleTime()}, 1000);	// 1000 = 1s
				function countSprinkleTime() {
					entry.count ++;
					if (entry.count < entry.wateringTime) {
						// zeit läuft
						adapter.setState('sprinkle.' + entry.sprinkleName + '.countdown', { val: addTime(entry.wateringTime - entry.count), ack: true});
						// Intervallberegnung wenn angegeben (onOffTime > 0)
						if ((entry.onOffTime > 0) && !(entry.count % entry.onOffTime)) {
							entry.enabled = false;
							entry.myBreak = true;
							adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', { val: 3, ack: true});	// Zustand des Ventils im Thread <<< 0 >>> Aus, < 1 > warten,
							adapter.setForeignState(entry.name, {val: false, ack: false});	// Ventil ausschalten
							ObjThread.updateList();
							clearInterval(entry.countdown);
							entry.onOffTimeoutOff = setTimeout(()=>{
								entry.myBreak = false;
								adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', { val: 1, ack: true});	// Zustand des Ventils im Thread <<< 0 >>> Aus, < 1 > warten,
								ObjThread.updateList();
							},1000 * entry.onOffTime);
						}						
					} else {
						adapter.setForeignState(entry.name, {val: false, ack: false});	// Ventil ausschalten
						adapter.setState('sprinkle.' + entry.sprinkleName + '.sprinklerState', { val: 0, ack: true});	// Zustand des Ventils im Thread <<< 0 >>> Aus, < 1 > warten, < 2 > Active, < 3 > Pause
						adapter.setState('sprinkle.' + entry.sprinkleName + '.runningTime', { val: 0, ack: true});
						adapter.setState('sprinkle.' + entry.sprinkleName + '.countdown', { val: 0, ack: true});
						adapter.setState('sprinkle.' + entry.sprinkleName + '.history.lastConsumed', { val: Math.round(entry.litersPerSecond * entry.count), ack: true});					
						adapter.setState('sprinkle.' + entry.sprinkleName + '.history.lastRunningTime', { val: addTime(entry.count), ack: true});
						adapter.setState('sprinkle.' + entry.sprinkleName + '.history.lastOn', { val: formatTime(entry.startTime, 'dd.mm. hh:mm'), ack: true});
						adapter.getState('sprinkle.' + entry.sprinkleName + '.history.curCalWeekConsumed', (err, state) => {
							if (state) {
								adapter.setState('sprinkle.' + entry.sprinkleName + '.history.curCalWeekConsumed', { val: (state.val) + Math.round(entry.litersPerSecond * entry.count), ack: false});
							}
						});
						adapter.getState('sprinkle.' + entry.sprinkleName + '.history.curCalWeekRunningTime', (err, state) => {
							if (state) {
								adapter.setState('sprinkle.' + entry.sprinkleName + '.history.curCalWeekRunningTime', { val: addTime(state.val,entry.count), ack: true});
							}
						});
						ObjThread.delList(entry.sprinkleName);
						clearInterval(entry.countdown);
						/*clearTimeout(entry.onOffTimeoutOn);*/
						clearTimeout(entry.onOffTimeoutOff);
					}

				}
			}
		}
		
		adapter.setState('control.parallelOfMax', {val: parallel + ' : ' + maxParallel, ack: true});
		adapter.setState('control.restFlow', {val: curFlow, ack: true});
		// Steuerspannung ein/aus
		if (adapter.config.triggerControlVoltage != '') {
			adapter.getForeignState(adapter.config.triggerControlVoltage, (err, state) => {
				if (state) {
					if (parallel > 0) {
						if (state.val == false) {
								adapter.setForeignState(adapter.config.triggerControlVoltage, {val: true, ack: false});
							}
					} else {
						adapter.setForeignState(adapter.config.triggerControlVoltage, {val: false , ack: false});
					}
				} else if (err) {
					adapter.log.error('triggerControlVoltage is not available (ist nicht erreichbar): ' + err);
				}
			});
		}
		
		// Pumpe ein/aus
		if (adapter.config.triggerMainPump != '') {
			adapter.getForeignState(adapter.config.triggerMainPump, (err, state) => {
				if (state) {
					if (parallel > 0) {
						if (state.val == false) {
							adapter.setForeignState(adapter.config.triggerMainPump, {val: true, ack: false});
						}
					} else {
						adapter.setForeignState(adapter.config.triggerMainPump, {val: false, ack: false});
					}				
				} else if (err) {
					adapter.log.error('triggerMainPump is not available (ist nicht erreichbar): ' + err);
				}
			});
		}
		
	} // End updateList
	
} // End ObjThread
//
function startAdapter(options) {
    // Create the adapter and define its methods => Erstellen Sie den Adapter und definieren Sie seine Methoden
    return adapter = utils.adapter(Object.assign({}, options, {
        name: adapterName,

        /* The ready callback is called when databases are connected and adapter received configuration.
		*=> Der Ready Callback wird aufgerufen, wenn die Datenbanken verbunden sind und der Adapter die Konfiguration erhalten hat.
        * start here! => Starte hier
        */
		ready: main, // Main method defined below for readability => Hauptmethode für die Lesbarkeit unten definiert

        /*
		* is called when adapter shuts down - callback has to be called under any circumstances!
		* => wird beim Herunterfahren des Adapters aufgerufen - Callback muss unbedingt aufgerufen werden!
        */
		unload: (callback) => {
            try {
                adapter.log.info('cleaned everything up...');
                callback();
            } catch (e) {
                callback();
            }
        },

        /*
		* is called if a subscribed object changes
		* => wird aufgerufen, wenn sich ein abonniertes Objekt ändert
		*/
        objectChange: (id, obj) => {
            if (obj) {
                // The object was changed
				if (adapter.config.publicHolidays === true) {
					if (id === adapter.config.publicHolInstance + '.heute.boolean') {
						publicHolidayStr = state.val;
						startTimeSprinkle();
					}
					if (id === adapter.config.publicHolInstance + '.morgen.boolean') {
						publicHolidayTomorowStr = state.val;
						// startTimeSprinkle();
					}
				}
				
                adapter.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
            } else {
                // The object was deleted
                adapter.log.info(`object ${id} deleted`);
            }
        },

        /*
		* is called if a subscribed state changes
		* wird aufgerufen, wenn sich ein abonnierter Status ändert
		*/
        stateChange: (id, state) => {
            if (state) {
                // The state was changed => Der Zustand wurde geändert
                adapter.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
				// wenn (Holiday == true) ist, soll das Wochenendprogramm gefahren werden. 
				if (id === adapter.namespace + '.control.Holiday') {
					HolidayStr = state.val;
					startTimeSprinkle();
				}
				// wenn (autoOnOff == true) so werden alle Spränger nicht automatisch gestartet.
				if (id === adapter.namespace + '.control.autoOnOff') {
					autoOnOffStr = state.val;
					// startTimeSprinkle();
				}
				// wenn (sprinkleName.runningTime sich ändert) so wird der aktuelle Spränger [sprinkleName] nicht gestartet
				if (resRunningTime && !state.ack) {
					for ( const i in resRunningTime) {
						if (id === (resRunningTime[i].objectID)) {
							if (!isNaN(state.val)) {
							//if (state.val.indexOf(':') == -1) {	// Kontolle ob es sich um eine Eingabe handelt, Eingabe Zahl in Minuten, keine Eingabe mm:ss 
								//resRunningTime[i].val = state.val;
								(state.val < 0 )?(resRunningTime[i].val = false):(resRunningTime[i].val = true);
								let resultFull = adapter.config.events;
								let resEnabled = resultFull.filter(d => d.enabled === true);
								let result = resEnabled;
								if (result) {
									for (const r in result) {
										let objectName = result[i].sprinkleName.replace(/[.;, ]/g, '_');
										if (objectName == resRunningTime[i].objectName) {
											ObjThread.addList(objectName, result[r].name, Math.round(60*state.val), result[r].pipeFlow, Math.round(60*result[r].wateringInterval));	// sprinkleName, name, wateringTime, pipeFlow
											setTimeout (() => {
												ObjThread.updateList();
											}, 50);
										}
									}
								}
							}
						}
					}
				}				
				// Change in outside temperature => Änderung der Außentemperatur
				if (id === adapter.config.sensorOutsideTemperature) {	/*Temperatur*/
					let timeDifference;
					curTemperature = state.val;
					timeDifference = (state.ts - lastChangeEvaPor) / 86400000;		// 24/h * 60/min * 60/s * 1000/ms = 86400000 ms
					//
					if (timeDifference) {
						setTimeout(function() {
							adapter.log.info('ts: ' + state.ts + ' - lastChangeEvaPor: ' +  lastChangeEvaPor + ' = timeDifference: ' + timeDifference);
							calcEvaporation(timeDifference);
						}, 500);
					} 
					lastChangeEvaPor = state.ts;	
				}
				// LuftFeuchtigkeit
				if (id === adapter.config.sensorOutsideHumidity) {
					curHumidity = state.val;
				}
				// Helligkeit
				if (id === adapter.config.sensorBrightness) {
					curIllumination = state.val;
				}
				// Windgeschwindigkeit
				if (id === adapter.config.sensorWindSpeed) {
					curWindSpeed = state.val;
				}			
				// Regenkontainer
				/* If the amount of rain is over 20 mm, the 'lastRainCounter' is overwritten and no calculation is carried out. =>
				* Wenn die Regenmenge mehr als 20 mm beträgt, wird der 'lastRainCounter' überschrieben und es wird keine Berechnung durchgeführt. */				
				if (id === adapter.config.sensorRainfall) {
					if (Math.abs(lastRainCounter - state.val) > 10) {
						curAmountOfRain = 0;
						adapter.log.info('if => Math.abs: ' + Math.abs(lastRainCounter - state.val) + ' curAmountOfRain: ' + curAmountOfRain);
					} else {
						curAmountOfRain = state.val - lastRainCounter;
						adapter.log.info('else => Math.abs: ' + Math.abs(lastRainCounter - state.val) + ' curAmountOfRain: ' + curAmountOfRain);
					}
					lastRainCounter = state.val;
					adapter.log.info('lastRainCounter: ' + lastRainCounter + ' curAmountOfRain: ' + curAmountOfRain + ' state.val: ' + state.val);
				}
				// 
				if (adapter.config.publicHolidays === true) {
					if (id === adapter.config.publicHolInstance + '.heute.boolean') {
						publicHolidayStr = state.val;
						startTimeSprinkle();
					}
					if (id === adapter.config.publicHolInstance + '.morgen.boolean') {
						publicHolidayTomorowStr = state.val;
						// startTimeSprinkle();
					}
				}	
            } else {
                // The state was deleted
                adapter.log.info(`state ${id} deleted`);
            }
        },
		

        // Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
		// Über das Meldungsfeld wurde eine Nachricht an die Adapterinstanz gesendet. Verwendung per E-Mail, Pushover, Text2Speech, ...
        // requires "common.message" property to be set to true in io-package.json
		// erfordert, dass die Eigenschaft "common.message" in "io-package.json" auf "true" gesetzt ist
        // message: (obj) => {
        // 	if (typeof obj === 'object' && obj.message) {
        // 		if (obj.command === 'send') {
        // 			// e.g. send email or pushover or whatever => E-Mail oder Pushover oder was auch immer
        // 			adapter.log.info('send command');

        // 			// Send response in callback if required => Senden Sie bei Bedarf eine Antwort im Rückruf
        // 			if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
        // 		}
        // 	}
        // },
    }));
}
// evaporation calculation => Verdunstungsberechnung
function calcEvaporation (timeDifference) {
	adapter.log.info('calcEvaporation => gestartet TimeDifferenz: ' + timeDifference);
	//	Sonnenscheindauer in %
	let curSunshineDuration = (curIllumination < 100) ? (0) : (curIllumination > 7000) ? (1) : ((curIllumination - 100) / (6900));
	
	// Extraterrestrische Strahlung in W/m³
	// let ExStra = [86,149,247,354,439,479,459,388,287,184,104,70];   // "53NB"
	// my $m = strftime("%m", localtime);
	// my $RE = $ExStra[$m];
	let RE = 45.8 * maxSunshine - 293;

	// Sättigungsdampfdruck Es in hPa
	let m1 = 6.11 * ( 10 ** (( 7.48 * curTemperature ) / ( 237 + curTemperature )));

	// Dampfdruck Ea
	let m2 = m1 * curHumidity / 100;
		
    // Globalstrahlung RG
	let m3 = (0.19 + 0.55 * curSunshineDuration) * RE;

	// Abstrahlung I in W/m²
	let m4 = 5.67E-8 * (( curSunshineDuration + 273 ) ** 4 ) * ( 0.56 - 0.08 * ( m2 ** 0.5 )) * ( 0.1 + ( 0.9 * curSunshineDuration));
		
	// Strahlungsäquivalent EH in mm/d
	let m5 = ( m3 * ( 1 - 0.2 ) - m4 ) / 28.3;	
		
	// Steigung der Sättigungsdampfdruckkurve Delta in hPa/K
	let m6 = ( m1 * 4032 ) / (( 237 + curTemperature ) ** 2 );

	// Windfunktion f(v) in mm/d hPa
	let m7 = 0.13 + 0.14 * curWindSpeed / 3.6;
	
	// pot. Evapotranspiration nach Penmann ETp in mm/d
    let eTp = (( m6 * m5 + 0.65 * m7 * ( m1 - m2 )) / ( m6 + 0.65 ));
        adapter.log.info('RE: ' + RE);
        adapter.log.info(' ETp:' + eTp);
		adapter.setState('evaporation.ETpCurrent', { val: eTp, ack: true });
	
	// Verdunstung des heutigen Tages
	let curETp = (eTp * timeDifference) - curAmountOfRain;
	curAmountOfRain = 0;	// auf 0 setzen damit nicht doppelt abgezogen wird.
	
		adapter.getState('evaporation.ETpToday', (err, state) => {
			if (state) {
				let sumCurETp;
				let curDay = new Date(state.ts).getDay;
				if (dayStr == curDay) {
					sumCurETp = state.val + curETp;
					adapter.setState('evaporation.ETpToday', { val: sumCurETp, ack: true });
				} else {	// neuer Tag
					dayStr = curDay;
					adapter.setState('evaporation.ETpYesterday', { val: state.val, ack: true});
					adapter.setState('evaporation.ETpToday', { val: curETp, ack: true });
				}
			}
		});
	applyEvaporation (curETp);
}
// apply Evaporation => Verdunstung anwenden auf die einzelnen Sprengerkreise
function applyEvaporation (eTP){
    let resultFull = adapter.config.events;
	// Filter enabled => nur aktivierte Sprängerkreise
	let resEnabled = resultFull.filter(d => d.enabled === true);
	let result = resEnabled;		
    if (result) {
	
		for ( const i in result) {
			let objectName = result[i].sprinkleName.replace(/[.;, ]/g, '_');
			let pfadActSoiMoi = 'sprinkle.' + objectName + '.actualSoilMoisture';
			let newSoilMoisture;
			resActSoilMoisture[objectName].val -= eTP;		// Abfrage => resActSoilMoisture[objectName].val;
			if (resActSoilMoisture[objectName].val < resActSoilMoisture[objectName].min) {
				resActSoilMoisture[objectName].val = resActSoilMoisture[objectName].min;
			} else if (resActSoilMoisture[objectName].val > result[i].maxSoilMoistureRain) {
				resActSoilMoisture[objectName].val = result[i].maxSoilMoistureRain;
			}
			newSoilMoisture = Math.round(1000 * resActSoilMoisture[objectName].val / result[i].maxSoilMoistureRain) / 10;	// Berechnung in %
			adapter.log.info(objectName + ' => soilMoisture: ' + resActSoilMoisture[objectName].val + ' soilMoisture in %: ' + newSoilMoisture + ' %');
			adapter.setState(pfadActSoiMoi, {val: newSoilMoisture, ack: true});
		}
	}		
}
// func addTime (02:12:24 + 00:15) || (807) = 02:12:39
function addTime(time1, time2){
    let wert = string2seconds(time1) + string2seconds(time2);
    return seconds2string(wert);

    // private functions
    function seconds2string(n){
        n = Math.abs(n);
        let h = Math.trunc(n / 3600);
        let m = Math.trunc((n / 60 ) % 60);
        let sec = Math.trunc(n % 60);
        return (h==0)?(frmt(m) + ':' + frmt(sec)):(frmt(h) + ':' + frmt(m) + ':' + frmt(sec));
    }   //  end function seconds2string
    
    function string2seconds(n) {
        if(!n) return 0;
        if(Number.isInteger(n)) return n;
        let tmp = n.split(':').reverse();
        if(!tmp.length) tmp[0] = 0;	// Sekunden
        if(tmp.length < 2) tmp[1] = 0;	// Minuten
        if(tmp.length < 3) tmp[2] = 0;	// Stunden
        while(tmp[0] > 59) {
            tmp[0] -= 60;
            ++tmp[1];
        }
        while(tmp[1] > 59) {
            tmp[1] -= 60;
            ++tmp[2];
        }
        return (tmp[2] * 3600 + tmp[1] * 60 + 1 * tmp[0]);
    }   //  string2seconds

    function frmt(n) { return n < 10 ? '0' + n : n;}

}   // end - function addTime
// func Format Time
function formatTime(myDate, timeFormat) {	// 'kW' 'dd.mm. hh:mm' 
	function zweistellen (s) {
		while (s.toString().length < 2) {s = "0" + s;}
		return s;
	}

	let d = (myDate)? new Date(myDate):new Date();
	let tag = zweistellen(d.getDate());
	let monat = zweistellen(d.getMonth() + 1);
	let stunde = zweistellen(d.getHours());
	let minute = zweistellen(d.getMinutes());
	
	switch (timeFormat) {
		case 'kW':	// formatTime('','kW');
			let currentThursday = new Date(d.getTime() +(3-((d.getDay()+6) % 7)) * 86400000);
			// At the beginnig or end of a year the thursday could be in another year.
			let yearOfThursday = currentThursday.getFullYear();
			// Get first Thursday of the year
			let firstThursday = new Date(new Date(yearOfThursday,0,4).getTime() +(3-((new Date(yearOfThursday,0,4).getDay()+6) % 7)) * 86400000);
			// +1 we start with week number 1
			// +0.5 an easy and dirty way to round result (in combinationen with Math.floor)
			return Math.floor(1 + 0.5 + (currentThursday.getTime() - firstThursday.getTime()) / 86400000/7);
			
		case 'dd.mm. hh:mm':
			return tag + "." + monat + " " + stunde + ":" + minute;
		
		case 'default':
			adapter.log.info('function formatTime: falsches Format angegeben')
			break;
	}
}
// Sets the status at start to a defined value => Setzt den Status beim Start auf einen definierten Wert
function checkStates() {
	//
    adapter.getState('control.Holiday', (err, state) => {
        if (state === null || state.val === null) {
            adapter.setState('control.Holiday', {val: false, ack: true});
        }
    });
    adapter.getState('control.autoOnOff', (err, state) => {
        if (state === null || state.val === null) {
            adapter.setState('control.autoOnOff', {val: true, ack: true});
        }
    });
    adapter.getState('evaporation.ETpToday', (err, state) => {
        if (state === null || state.val === null) {
            adapter.setState('evaporation.ETpToday', {val: 0, ack: true});
        }
    });
    adapter.getState('evaporation.ETpYesterday', (err, state) => {
        if (state === null || state.val === null) {
            adapter.setState('evaporation.ETpYesterday', {val: 0, ack: true});
        }
    });
	if (adapter.config.triggerMainPump != '') {
		adapter.getState('adapter.config.triggerMainPump', (err, state) => {
			if (state) {
				adapter.setState(adapter.config.triggerMainPump, {val: false, ack: false});
			}
		});
	}
	if (adapter.config.triggerCisternPump != '') {
		adapter.getState('adapter.config.triggerCisternPump', (err, state) => {
			if (state) {
				adapter.setState(adapter.config.triggerCisternPump, {val: false, ack: false});
			}
		});
	}
	let result = adapter.config.events;
    if (result) {	
        for ( const i in result) {
			adapter.getState(result[i].name, (err, state) => {
				if (state) {
					adapter.setState(result[i].name, {val: false, ack: false});
				}
			});			
		}
	}
	// akt. kW ermitteln für history last week
	kwStr = formatTime('','kW');	
};
//	aktuelle States checken nach 2000 ms
function checkActualStates () {
	//
    adapter.getState('control.Holiday', (err, state) => {
        if (state) {
            HolidayStr = state.val;
        }
    });
    adapter.getState('control.autoOnOff', (err, state) => {
        if (state) {
            autoOnOffStr = state.val;
        }
    });
	//
    if (adapter.config.publicHolidays === true && (adapter.config.publicHolInstance != 'none' || adapter.config.publicHolInstance != '')) {
        adapter.getForeignState(adapter.config.publicHolInstance + '.heute.boolean', (err, state) => {
            if (state) {
                publicHolidayStr = state.val;
            }
        });
        adapter.getForeignState(adapter.config.publicHolInstance + '.morgen.boolean', (err, state) => {
            if (state) {
                publicHolidayTomorowStr = state.val;
            }
        });
    }
	//
    adapter.getForeignObjects(adapter.namespace + ".sprinkle.*", 'channel', function (err, list) {
        if (err) {
            adapter.log.error(err);
        } else {
            ObjSprinkle = list;
        }
    });	
	
	//
    setTimeout(function() {
        createSprinklers();
    }, 1000);
	setTimeout(function() {
        startTimeSprinkle();
    }, 2000);
	
}
// at 0:05 start of StartTimeSprinkle => um 0:05 start von StartTimeSprinkle
const calcPos = schedule.scheduleJob('calcPosTimer', '* 0 5 * * *', function() {
	// Berechnungen mittels SunCalc
	sunPos();

	// History Daten aktualisieren wenn eine neue Woche beginnt
	if (kwStr != formatTime('','kW')) {
		let resultFull = adapter.config.events;
		// Filter enabled
		let resEnabled = resultFull.filter(d => d.enabled === true);
		let result = resEnabled;
		if (result) {	
			for ( const i in result) {
				let objectName = result[i].sprinkleName.replace(/[.;, ]/g, '_');
				adapter.getState('sprinkle.' + objectName + '.history.curCalWeekConsumed', (err, state) => {
					if (state) {
							adapter.setState('sprinkle.' + objectName + '.history.lastCalWeekConsumed', { val: state.val, ack: true });
							adapter.setState('sprinkle.' + objectName + '.history.curCalWeekConsumed', { val: 0, ack: true });
					}
				});
				adapter.getState('sprinkle.' + objectName + '.history.curCalWeekRunningTime', (err, state) => {
					if (state) {
							adapter.setState('sprinkle.' + objectName + '.history.lastCalWeekRunningTime', { val: state.val, ack: true });
							adapter.setState('sprinkle.' + objectName + '.history.curCalWeekRunningTime', { val: 0, ack: true });
					}
				});				
			}
		}
		kwStr = formatTime('','kW');
	}

	// ETpToday und ETpYesterday in evaporation aktualisieren da ein neuer Tag
	setTimeout(function() {
		adapter.getState('evaporation.ETpToday', (err, state) => {
			if (state) {
				adapter.setState('evaporation.ETpYesterday', { val: state.val, ack: true });
				adapter.setState('evaporation.ETpToday', { val: 0, ack: true });				
			}
		});	
	},100);
	
	// Startzeit Festlegen => verzögert wegen Daten von SunCalc
	setTimeout(function() {
		startTimeSprinkle();
	},1000);
    
});
// Berechnung mittels sunCalc
function sunPos() {
    // get today's sunlight times => Holen Sie sich die heutige Sonnenlicht Zeit	
	let times = SunCalc.getTimes(new Date(), adapter.config.latitude, adapter.config.longitude);
	
	//Sonnenscheindauer in Stunden)
	maxSunshine = (('0' + times.sunset.getTime() - times.sunrise.getTime()) / 3600000); 
	
	// Berechnung des heutigen Tages
	dayStr = times.sunrise.getDay();
	
    // format sunrise time from the Date object => Formatieren Sie die Sonnenaufgangzeit aus dem Date-Objekt
    sunriseStr = ('0' + times.sunrise.getHours()).slice(-2) + ':' + ('0' + times.sunrise.getMinutes()).slice(-2);
    adapter.setState('info.Sunrise', { val: sunriseStr, ack: true });

    // format goldenhourend time from the Date object => Formatiere goldenhourend time aus dem Date-Objekt
    goldenHourEnd = ('0' + times.goldenHourEnd.getHours()).slice(-2) + ':' + ('0' + times.goldenHourEnd.getMinutes()).slice(-2);
    adapter.setState('info.GoldenHourEnd', { val: goldenHourEnd, ack: true });
	
}
// Determination of the irrigation time => Bestimmung der Bewässerungszeit
function startTimeSprinkle() {
	
	schedule.cancelJob('sprinkleStartTime'); 

	// if autoOnOff == false => keine auto Start
	if (!autoOnOffStr) {
		adapter.log.info('Sprinkle: autoOnOff == Aus(' + autoOnOffStr + ')');
		return;
	}
	
	let infoMesetsch;

    adapter.setState('info.TimeLiving', { val: adapter.config.weekLiving, ack: true });
    adapter.setState('info.TimeLivingWE', { val: adapter.config.weekEndLiving, ack: true });	

	// Start time variant according to configuration => Startzeitvariante gemäß Konfiguration
	switch(adapter.config.wateringStartTime) {
		case 'livingTime' :				/*Startauswahl = festen Zeit*/
			infoMesetsch = 'Start zur festen Zeit um ';
			startTime = adapter.config.weekLiving;
			break;
		case 'livingSunrise' :			/*Startauswahl = Sonnenaufgang*/
			infoMesetsch = 'Start mit Sonnenaufgang um ';
		    // format sunset/sunrise time from the Date object
			startTime = sunriseStr;
			break;
		case 'livingGoldenHourEnd' :	/*Startauswahl = Ende der Golden Houer*/
			infoMesetsch = "Start zum Ende der Golden Houer um ";
			// format goldenhour/goldenhourend time from the Date object
			startTime = goldenHourEnd;
			break;
    }
	// Start am Wochenende => wenn andere Zeiten verwendet werden soll
	if((adapter.config.publicWeekend) && ((dayStr) == 6 || (dayStr) == 0)){
		infoMesetsch = 'Start am Wochenende um ';
		startTime = adapter.config.weekEndLiving;
	}
	// Start an Feiertagen => wenn Zeiten des Wochenendes verwendet werden soll
	if((adapter.config.publicHolidays) && (adapter.config.publicWeekend) && ((publicHolidayStr) === true)){
		infoMesetsch = 'Start am Feiertag um ';
		startTime = adapter.config.weekEndLiving;
	}
	
	let startTimeSplit = startTime.split(':');
	adapter.log.info(infoMesetsch + startTime);

	const schedStartTime = schedule.scheduleJob('sprinkleStartTime', startTimeSplit[1] + ' ' + startTimeSplit[0] + ' * * *', function() {
		let resultFull = adapter.config.events;
		// Filter enabled
		let resEnabled = resultFull.filter(d => d.enabled === true);
		let result = resEnabled;
		if (result) {	
			for (const i in result) {
				let objectName = result[i].sprinkleName.replace(/[.;, ]/g, '_');
				adapter.getState('sprinkle.' + objectName + '.actualSoilMoisture', (err, state) => {
					if (state) {
						// Test	
						const resIndex = resRunningTime.findIndex(d => d.objectName == objectName);
						adapter.log.info('Bodenfeuchte: ' + state.val + ' <= ' + parseInt(result[i].triggersIrrigation) + ' AutoOnOff: ' + resRunningTime[resIndex].val);
						if (state.val <= parseInt(result[i].triggersIrrigation) && (resRunningTime[resIndex].val)) {	// Bodenfeuchte zu gering && Ventil auf Automatik
							let countdown = Math.round(result[i].wateringTime * (result[i].maxSoilMoistureIrrigation - resActSoilMoisture[objectName].val) / (result[i].maxSoilMoistureIrrigation - resActSoilMoisture[objectName].trigger)); // in sek
							if (countdown > (result[i].wateringTime * result[i].wateringAdd / 100)) {	// Begrenzung der Bewässerungszeit auf dem in der Config eingestellten Überschreitung (Proz.)
								countdown = result[i].wateringTime * result[i].wateringAdd / 100;
							}
							adapter.log.info('sprinkleControll: ' + objectName + '  wateringTime: ' + countdown + ' (' + result[i].wateringTime + ', ' + result[i].maxSoilMoistureIrrigation + ', ' + resActSoilMoisture[objectName].val + ', ' + resActSoilMoisture[objectName].trigger + ')');
							ObjThread.addList(objectName, result[i].name, 60*countdown, result[i].pipeFlow, 60*result[i].wateringInterval);	// sprinkleName, name, wateringTime, pipeFlow
						}
					}
				});
			}
		}
		setTimeout (() => {
			ObjThread.updateList();
		}, 50);
	});
}
//
function createSprinklers() {
    let result = adapter.config.events;
    if (result) {	
        for ( const i in result) {
            let objectName = result[i].sprinkleName.replace(/[.;, ]/g, '_');
			let objPfad = 'sprinkle.' + objectName;
			// resObjektName für aktualisierungen speichern
			resObjektName.push([objectName]);
			// Create Object for sprinklers (ID)
			adapter.setObjectNotExists('sprinkle.' + objectName, {
				"type": "channel",
				"common": {
					"name": result[i].sprinkleName
				},
				"native": {},
			});
			// Create Object for sprinklers (ID)
			adapter.setObjectNotExists('sprinkle.' + objectName + '.history', {
				"type": "channel",
				"common": {
					"name": result[i].sprinkleName + ' => History'
				},
				"native": {},
			});

			// actual soil moisture
            // Create .actualSoilMoisture
            adapter.setObjectNotExists(objPfad + '.actualSoilMoisture', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => actual soil moisture in %",
                    "type":  "number",
					"min":   0,
					"max":   100,
					"unit":  "%",					
                    "read":  true,
                    "write": false,
                    "def":   true
                },
                "native": {},
            });
			// actual state of sprinkler => Zustand des Ventils im Thread
			// <<< 1  = warten >>> ( 0 = Aus, 2 = Active, 3 = Pause )
            // Create .sprinklerState
            adapter.setObjectNotExists(objPfad + '.sprinklerState', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => actual state of sprinkler",
                    "type":  "number",
					"min":	0,
					"max":	3,
					"states": "0:off;1:wait;2:on;3:break",
                    "read":  true,
                    "write": false,
                    "def":   true
                },
                "native": {},
            });
			// running time of sprinkler => Laufzeit des Ventils
            adapter.setObjectNotExists(objPfad + '.runningTime', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => running time of sprinkler",
                    "type":  "string",
                    "read":  true,
                    "write": true,
                    "def":   true
                },
                "native": {},
            });
			// countdown of sprinkler => Countdown des Ventils
            adapter.setObjectNotExists(objPfad + '.countdown', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => countdown of sprinkler",
                    "type":  "string",
                    "read":  true,
                    "write": false,
                    "def":   true
                },
                "native": {},
            });
			// History - Last running time of sprinkler => History - Letzte Laufzeit des Ventils (0 sek, 47:00 min, 1:03:45 )
            adapter.setObjectNotExists(objPfad + '.history.lastRunningTime', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => History - Last running time",
                    "type":  "string",
                    "read":  true,
                    "write": false,
                    "def":   true
                },
                "native": {},
            });
			// History - Last On of sprinkler => History - Letzter Start des Ventils (30.03 06:30)
            adapter.setObjectNotExists(objPfad + '.history.lastOn', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => History - Last On of sprinkler",
                    "type":  "string",
                    "read":  true,
                    "write": false,
                    "def":   true
                },
                "native": {},
            });
			// History - Last consumed of sprinkler => History - Letzte Verbrauchsmenge des Ventils (783 Liter)
            adapter.setObjectNotExists(objPfad + '.history.lastConsumed', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => History - Last consumed of sprinkler",
                    "type":  "number",
					"unit":  "Liter",
                    "read":  true,
                    "write": false,
                    "def":   true
                },
                "native": {},
            });
			// History - Sprinkler consumption of the current calendar week => History - Sprinkler-Verbrauch der aktuellen Kalenderwoche (783 Liter)
            adapter.setObjectNotExists(objPfad + '.history.curCalWeekConsumed', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => History - Sprinkler consumption of the current calendar week",
                    "type":  "number",
					"unit":  "Liter",
                    "read":  true,
                    "write": false,
                    "def":   true
                },
                "native": {},
            });
			// History - Sprinkler consumption of the last calendar week => History - Sprinkler-Verbrauch der letzten Kalenderwoche (783 Liter)
            adapter.setObjectNotExists(objPfad + '.history.lastCalWeekConsumed', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => History - Sprinkler consumption of the last calendar week",
                    "type":  "number",
					"unit":  "Liter",
                    "read":  true,
                    "write": false,
                    "def":   true
                },
                "native": {},
            });
			// History - Sprinkler running time of the current calendar week => History - Sprinkler-Lauzeit der aktuellen Kalenderwoche (783 Liter)
            adapter.setObjectNotExists(objPfad + '.history.curCalWeekRunningTime', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => History - Sprinkler running time of the current calendar week",
                    "type":  "string",
                    "read":  true,
                    "write": false,
                    "def":   true
                },
                "native": {},
            });
			// History - Sprinkler running time of the last calendar week => History - Sprinkler-Laufzeit der letzten Kalenderwoche (783 Liter)
            adapter.setObjectNotExists(objPfad + '.history.lastCalWeekRunningTime', {
                "type": "state",
                "common": {
                    "role":  "state",
                    "name":  objectName + " => History - Sprinkler running time of the last calendar week",
                    "type":  "string",
                    "read":  true,
                    "write": false,
                    "def":   true
                },
                "native": {},
            });			
			setTimeout(() => {
				adapter.getState(objPfad + '.actualSoilMoisture', (err, state) => {
					let newEntry = {};
					let soilMoisture, minMoisture, actSoilMoisture, triggerSoilMoisture;

					resActSoilMoisture.push([objectName]);
					minMoisture = result[i].maxSoilMoistureRain / 10;
					triggerSoilMoisture = result[i].maxSoilMoistureIrrigation * result[i].triggersIrrigation / 100;
					
					if (state === null || state.val === null || state.val === true || state.val === 0) {
						// 0% Wert der Bodenfeuchte im Array speichern. Spränger werden sofort eingeschaltet.
						soilMoisture = minMoisture;
						actSoilMoisture = Math.round(1000 * soilMoisture / result[i].maxSoilMoistureRain) / 10;	// Berechnung in %
						adapter.setState(objPfad + '.actualSoilMoisture', {val: actSoilMoisture, ack: true});
					} else {
						// num Wert der Bodenfeuchte berechnen und speichern im Array							
						soilMoisture = state.val * result[i].maxSoilMoistureRain / 100;
					}
					newEntry = {'val': soilMoisture, 'min': minMoisture, 'trigger': triggerSoilMoisture};	// val: actueller Wert, min: geringst möglicher Wert, trigger: Schaltpunkt 
					resActSoilMoisture[objectName] = newEntry;		// Abfrage => resActSoilMoisture[objectName].val;
					adapter.log.info('resActSoilMoisture: ' + objectName + ', .val: ' + resActSoilMoisture[objectName].val + ', state.val: ' + state.val + ', state: ' + state);
				});
				
				adapter.getState(objPfad + '.sprinklerState', (err, state) => {
					if (state) {
						adapter.setState(objPfad + '.sprinklerState', {val: 0, ack: true});
					}
				});
				adapter.getState(objPfad + '.runningTime', (err, state) => {
					if (state) {
						adapter.setState(objPfad + '.runningTime', {val: '00:00', ack: true});
					}
				});
				adapter.getState(objPfad + '.countdown', (err, state) => {
					if (state) {
						adapter.setState(objPfad + '.countdown', {val: 0, ack: true});
					}
				});
				// history		
				adapter.getState(objPfad + '.history.lastRunningTime', (err, state) => {
					if (state.val === true) {
						adapter.setState(objPfad + '.history.lastRunningTime', {val: '00:00', ack: true});
					}
				});
				adapter.getState(objPfad + '.history.lastOn', (err, state) => {
					if (state.val === true) {
						adapter.setState(objPfad + '.history.lastOn', {val: '-', ack: true});
					}
				});
				adapter.getState(objPfad + '.history.lastConsumed', (err, state) => {
					if (state.val === true) {
						adapter.setState(objPfad + '.history.lastConsumed', {val: 0, ack: true});
					}
				});
				adapter.getState(objPfad + '.history.curCalWeekConsumed', (err, state) => {
					if (state.val === true) {
						adapter.setState(objPfad + '.history.curCalWeekConsumed', {val: 0, ack: true});
					}
				});
				adapter.getState(objPfad + '.history.lastCalWeekConsumed', (err, state) => {
					if (state.val === true) {
						adapter.setState(objPfad + '.history.lastCalWeekConsumed', {val: 0, ack: true});
					}
				});
				adapter.getState(objPfad + '.history.curCalWeekRunningTime', (err, state) => {
					if (state.val === true) {
						adapter.setState(objPfad + '.history.curCalWeekRunningTime', {val: '00:00', ack: true});
					}
				});
				adapter.getState(objPfad + '.history.lastCalWeekRunningTime', (err, state) => {
					if (state.val === true) {
						adapter.setState(objPfad + '.history.lastCalWeekRunningTime', {val: '00:00', ack: true});
					}
				});
			},1500);
        }
		// delete old sprinkle
		for ( const i in ObjSprinkle) {

			const resID = ObjSprinkle[i]._id;
			const objectID = resID.split('.');
			const resultID = objectID[3];

			let resultName = result.map(({ sprinkleName }) => ({ sprinkleName }));
			let fullRes = []
			
			for ( const i in resultName) {
				let res = resultName[i].sprinkleName.replace(/[.;, ]/g, '_');
				fullRes.push(res);
			}
			setTimeout(() => {

				if (fullRes.indexOf(resultID) === -1) {
					// State löschen
					
					// History - Objekt(Ordner) löschen					
					adapter.delObject(resID + '.history', function (err) {
						if (err) {
							adapter.log.warn(err)
						}
					});					
					// State löschen
					adapter.delObject(resID + ".actualSoilMoisture");	// "sprinklecontrol.0.sprinkle.???.actualSoilMoisture"
					adapter.delObject(resID + ".sprinklerState");	// "sprinklecontrol.0.sprinkle.???.sprinklerState"
					adapter.delObject(resID + ".runningTime");	//	"sprinklecontrol.0.sprinkle.???.runningTime"
					adapter.delObject(resID + ".countdown");	//	"sprinklecontrol.0.sprinkle.???.countdown"
					adapter.delObject(resID + ".history.lastOn");	//	"sprinklecontrol.0.sprinkle.???..history.lastOn"
					adapter.delObject(resID + ".history.lastConsumed");	//	"sprinklecontrol.0.sprinkle.???..history.lastConsumed"
					adapter.delObject(resID + ".history.lastRunningTime");	// "sprinklecontrol.0.sprinkle.???.history.lastRunningTime"
					adapter.delObject(resID + ".history.curCalWeekConsumed");	//	"sprinklecontrol.0.sprinkle.???.curCalWeekConsumed"
					adapter.delObject(resID + ".history.lastCalWeekConsumed");	//	"sprinklecontrol.0.sprinkle.???.lastCalWeekConsumed"	
					adapter.delObject(resID + ".history.curCalWeekRunningTime");	//	"sprinklecontrol.0.sprinkle.???.curCalWeekRunningTime"	
					adapter.delObject(resID + ".history.lastCalWeekRunningTime");	//	"sprinklecontrol.0.sprinkle.???.history.lastCalWeekRunningTime"
					// Objekt(Ordner) löschen
					adapter.delObject(resID, function (err) {
						if (err) {
							adapter.log.warn(err);
						}
					});				
				}
			}, 1500);	

		}

    }
}
// Start
function main() {

    /* The adapters config (in the instance object everything under the attribute "native") is accessible via
    * adapter.config:
	* => Auf die Adapterkonfiguration (im Instanzobjekt alles unter dem Attribut "native") kann zugegriffen werden über 
	adapter.config:
	*/
    adapter.log.debug(JSON.stringify(adapter.config.events));
    
    adapter.getForeignObject('system.config', (err, obj) => {
        checkStates();
    });
    setTimeout(function() {
        checkActualStates();
        sunPos();
    }, 2000);


    /*
        For every state in the system there has to be also an object of type state
        Here a simple template for a boolean variable named "testVariable"
        Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
		=> 
		Für jeden Zustand im System muss es auch ein Objekt vom Typ Zustand geben
		Hier eine einfache Vorlage für eine boolesche Variable namens "testVariable"
		Da jede Adapterinstanz ihre eigenen eindeutigen Namespace-Variablennamen verwendet, können sie nicht mit anderen Adaptervariablen kollidieren
    
    adapter.setObject('testVariable', {
        type: 'state',
        common: {
            name: 'testVariable',
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: true,
        },
        native: {},
    });
	*/
	/*
    * in this template all states changes inside the adapters namespace are subscribed
	* => In dieser Vorlage werden alle Statusänderungen im Namensraum des Adapters abonniert
	* adapter.subscribeStates('*');
	*/

	// 
    adapter.subscribeStates('control.*');

    //adapter.subscribeStates('info.Elevation');
    //adapter.subscribeStates('info.Azimut');
	
	// Request a notification from a third-party adapter => Fordern Sie eine Benachrichtigung von einem Drittanbieteradapter an
    if (adapter.config.publicHolidays === true && (adapter.config.publicHolInstance + '.heute.*')) {
        adapter.subscribeForeignStates(adapter.config.publicHolInstance + '.heute.*');
    }
    if (adapter.config.publicHolidays === true && (adapter.config.publicHolInstance + '.morgen.*')) {
        adapter.subscribeForeignStates(adapter.config.publicHolInstance + '.morgen.*');
	}
    if (adapter.config.sensorBrightness != '') {
        adapter.subscribeForeignStates(adapter.config.sensorBrightness);
    }
	if (adapter.config.sensorOutsideHumidity != '') {
	adapter.subscribeForeignStates(adapter.config.sensorOutsideHumidity);
    }
    if (adapter.config.sensorOutsideTemperature != '') {
        adapter.subscribeForeignStates(adapter.config.sensorOutsideTemperature);
    }
    if (adapter.config.sensorRainfall != '') {
        adapter.subscribeForeignStates(adapter.config.sensorRainfall);
    }
	if (adapter.config.sensorWindSpeed != '') {
	adapter.subscribeForeignStates(adapter.config.sensorWindSpeed);
    }
	//
	// Change State from Trigger ID's
    let resultFull = adapter.config.events;
	// Filter enabled => nur aktivierte Sprängerkreise
	let resEnabled = resultFull.filter(d => d.enabled === true);
	let result = resEnabled;		
    if (result) {
        for ( const i in result) {
			/* Abbild des Objekts runningTime erstellen */
			let newEntry = [];
			let objectName = result[i].sprinkleName.replace(/[.;, ]/g, '_');
			newEntry.val = true;
			newEntry.objectName = objectName;
			newEntry.objectID = adapter.namespace + '.sprinkle.' + objectName + '.runningTime';
			newEntry.name = objectName + '.runningTime';
			resRunningTime.push(newEntry);
			adapter.subscribeStates(newEntry.objectID);	// abonieren der Statusänderungen des Objekts
        }
    }

				
			
	/*
	* setState examples
	* you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
	* setState Beispiele
	* Sie werden feststellen, dass bei jedem setState das stateChange-Ereignis ausgelöst wird (aufgrund des obigen subscribeStates cmd).
    */
	
    // the variable testVariable is set to true as command (ack=false)
	// => die Variable testVariable wird als Befehl auf true gesetzt (ack = false) es cmd)
    // adapter.setState('testVariable', true);

    // same thing, but the value is flagged "ack"
    // ack should be always set to true if the value is received from or acknowledged from the target system
	// => das gleiche, aber der Wert ist mit "ack" gekennzeichnet
	// => ack sollte immer auf true gesetzt werden, wenn der Wert vom Zielsystem empfangen oder bestätigt wird
    // adapter.setState('testVariable', { val: true, ack: true });

    // same thing, but the state is deleted after 30s (getState will return null afterwards)
	// => das gleiche, aber der Zustand wird nach 30s gelöscht (getState gibt danach null zurück)
    // adapter.setState('testVariable', { val: true, ack: true, expire: 30 });
/*
    // examples for the checkPassword/checkGroup functions
	// => Beispiele für die Funktionen checkPassword / checkGroup
    adapter.checkPassword('admin', 'iobroker', (res) => {
        adapter.log.info('check user admin pw ioboker: ' + res);
    });

    adapter.checkGroup('admin', 'admin', (res) => {
        adapter.log.info('check group user admin group admin: ' + res);
    });
*/
}

// @ts-ignore parent is a valid property on module
// => @ ts-ignore parent ist eine gültige Eigenschaft des Moduls
if (module.parent) {
    // Export startAdapter in compact mode => Exportieren Sie startAdapter im kompakten Modus
    module.exports = startAdapter;
} else {
    // otherwise start the instance directly => Andernfalls starten Sie die Instanz direkt
    startAdapter();
}