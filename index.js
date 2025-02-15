var http = require('http');

var Accessory, Characteristic, Consumption, Service, TotalConsumption, UUIDGen;

// Setting debug = true presents copious, unneeded logs
var debug = false;

var pluginName = "homebridge-plex-sensors";
var platformName = "Plex";

module.exports = function (homebridge) {
    Accessory = homebridge.platformAccessory;
    Characteristic = homebridge.hap.Characteristic;
    Service = homebridge.hap.Service;
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform(pluginName, platformName, Plex, true);
}

function Plex(log, config, api) {
    if (!config) {
        log.warn("Ignoring Plex Sensors because it is not configured");
        this.disabled = true;
        return;
    }
    this.log = log;
    this.api = api;
    this.accessories = {};
    this.sensors = config["sensors"];
    this.port = config["port"] || '22987';
    this.logSeenPlayersAndUsers = config["logSeenPlayersAndUsers"] || false;
    this.timeouts = {};
    debug = config["debug"] || false;
    var self = this;

    this.server = http.createServer(function(request, response) {
        let body = [];
        request.on('data', (chunk) => {
          body.push(chunk);
        }).on('end', () => {
          body = Buffer.concat(body).toString();
          self.httpHandler(self, body);
          response.end("");
        });
    });

    this.server.listen(this.port, function(){
        self.log("Homebridge Plex Sensors listening for webhooks on: http://<homebridge ip>:%s", self.port);
    });

    this.api.on('didFinishLaunching', function() {
        for(var sensor of self.sensors)
        {
            if (!sensor.hasOwnProperty("service"))
            {
                var uuid = UUIDGen.generate(sensor.name);
                if (!self.accessories[uuid])
                {
                    self.log("Adding '"+sensor.name+"' sensor.");
                    var accessory = new Accessory(sensor.name, uuid);

                    var service = accessory.addService(Service.OccupancySensor, sensor.name);

                    self.accessories[uuid] = accessory;
                    sensor.service = service;
                    sensor.accessory = accessory;
                    self.api.registerPlatformAccessories(pluginName, platformName, [accessory]);
                }
            }
            sensor.activePlayers = new Set();

            if (sensor.genres)
            {
                for (var i = 0; i < sensor.genres.length; i++)
                {
                    sensor.genres[i] = sensor.genres[i].toLowerCase();
                }
            }

            // To be compatable with older config files, if the ignorePauseResume variable is set, convert it to the trigger.playStop type.
            if (sensor.ignorePauseResume == true) {
              sensor.triggerType = "trigger.playstop";
            }
            // If TriggerType is not present in the config file set it to trigger.normal
            else if (!sensor.triggerType) {
              sensor.triggerType = "trigger.normal";
            }
            // Verify that the provide trigger type is valid and if not, set it to the default of trigger.normal
            else {
              sensor.triggerType = sensor.triggerType.toLowerCase();
              if ((sensor.triggerType != "trigger.playstop") && (sensor.triggerType != "trigger.pauseresume") && (sensor.triggerType != "trigger.scrobble")) {
                sensor.triggerType = "trigger.normal";
              }
            }

            var informationService = sensor.accessory.getService(Service.AccessoryInformation);
            informationService
              .setCharacteristic(Characteristic.Manufacturer, "Homebridge Sensors for Plex")
              .setCharacteristic(Characteristic.Model, "Plex Sensor")
              .setCharacteristic(Characteristic.SerialNumber, sensor.name);
        }

        var deleteAccessories = new Array();
        for (var accessoryUUID in self.accessories)
        {
            var accessory = self.accessories[accessoryUUID];
            var foundInSensors = false;
            for(var sensor of self.sensors)
            {
                if (accessory.services[1].displayName == sensor.name)
                {
                    foundInSensors = true;
                }
            }

            if (!foundInSensors)
            {
                delete self.accessories[accessory.UUID];
                deleteAccessories.push(accessory);
                self.log("Removing old '"+accessory.displayName+"' sensor no longer in config.");
            }
        }
        self.api.unregisterPlatformAccessories(pluginName, platformName, deleteAccessories);
    });
}

Plex.prototype.configureAccessory = function(accessory) {
    this.log("Configuring '"+accessory.displayName+"' sensor.");
    this.accessories[accessory.UUID] = accessory;
    for(var sensor of this.sensors)
    {
        if (accessory.services[1].displayName == sensor.name)
        {
            sensor.accessory = accessory;
            sensor.service = accessory.services[1];
            sensor.activePlayers = new Set();
        }
    }
}

Plex.prototype.debugLog = function(string)
{
    if (debug)
    {
        this.log(string);
    }
}

Plex.prototype.httpHandler = function(self, body) {
    var jsonStart = body.indexOf("{");
    var json = body.substring(jsonStart, body.indexOf("\n", jsonStart));
    var event;
    try {
        event = JSON.parse(json);
    }
    catch(e) {
        self.debugLog("Webhook URL called without JSON body.");
    }

    if (!event)
    {
        return;
    }

    self.debugLog("Plex incoming webhook");

    if ((self.logSeenPlayersAndUsers || debug)
        && event.event == "media.play")
    {
        self.log("Seen player: \""+event.Player.title+"\" (with UUID: \""+event.Player.uuid+"\")");
        self.log("Seen user: \""+event.Account.title+"\"");
    }

    self.debugLog("Processing event: "+json);

    for (var sensor of self.sensors) {
        self.processEvent(self, event, sensor);
    }
}

Plex.prototype.processEvent = function(self, event, sensor) {

  var activateSensor = false;

  // Parse the playback event. Based upon the sensorType choose to either ignore or process that event and to either set or clear the activateSensor flag.
  switch (event.event) {
    case "media.play":
      if ((sensor.triggerType == "trigger.normal") || (sensor.triggerType == "trigger.playstop")) {
        activateSensor = true;
      }
      else {
        self.debugLog("Play event ignored for sensor: "+sensor.name);
        return;
      }
      break;
    case "media.resume":
      if ((sensor.triggerType == "trigger.normal") || (sensor.triggerType == "trigger.pauseresume")) {
        activateSensor = (sensor.triggerType == "trigger.normal");
      }
      else {
        self.debugLog("Resume event ignored for sensor: "+sensor.name);
        return;
      }
      break;
    case "media.pause":
      if ((sensor.triggerType == "trigger.normal") || (sensor.triggerType == "trigger.pauseresume")) {
        activateSensor = (sensor.triggerType == "trigger.pauseresume");
      }
      else {
        self.debugLog("Pause event ignored for sensor: "+sensor.name);
        return;
      }
      break;
    case "media.stop":
      // All sensors will be deactivated upon a media.stop event.
      activateSensor = false;
      break;
    case "media.scrobble":
      // A meida.scrobble event is when the media file reaches 90% playback.
      if (sensor.triggerType == "trigger.scrobble") {
        activateSensor = true;
      }
      else {
        self.debugLog("Scrobble event ignored for sensor: "+sensor.name);
        return;
      }
      break;
    default:
      self.debugLog("'" + event.event + "' event ignored for sensor: "+sensor.name);
      return;
      break;
  }

    if (sensor.users
        && sensor.users.length > 0
        && sensor.users.indexOf(event.Account.title) == -1)
    {
        self.debugLog("Event doesn't match users for sensor: "+sensor.name);
        return;
    }
    if (sensor.players
        && sensor.players.length > 0
        && sensor.players.indexOf(event.Player.title) == -1
        && sensor.players.indexOf(event.Player.uuid) == -1)
    {
        self.debugLog("Event doesn't match players for sensor: "+sensor.name);
        return;
    }
    if (sensor.types
        && sensor.types.length > 0
        && sensor.types.indexOf(event.Metadata.type) == -1)
    {
        self.debugLog("Event doesn't match types for sensor: "+sensor.name);
        return;
    }
    if (sensor.genres
        && sensor.genres.length > 0)
    {
        var matches = false;
        self.debugLog("Testing genres for sensor: "+sensor.name);
        if (!event.Metadata.Genre
            || event.Metadata.Genre.length == 0)
        {
            self.debugLog("Event doesn't match genres for sensor: "+sensor.name);
            return;
        }

        for (var genre of event.Metadata.Genre)
        {
            if (sensor.genres.indexOf(genre.tag.toLowerCase()) > -1)
            {
                self.debugLog("Matched genre: "+genre.tag);
                matches = true;
            }
        }

        if (!matches)
        {
            self.debugLog("Event doesn't match genres for sensor: "+sensor.name);
            return;
        }
    }
    if (sensor.customFilters)
    {
        self.debugLog("Testing custom filters (all) for sensor: "+sensor.name);
        for (var filterPath of Object.keys(sensor.customFilters))
        {
            var eventValue = filterPath.split('.').reduce((previous, current) => {
                return previous[current];
            }, event);
            if (eventValue != sensor.customFilters[filterPath])
            {
                self.debugLog("Event doesn't match custom filter for sensor: "+sensor.name);
                return;
            }
        }
    }
    if (sensor.customFiltersAnyOf)
    {   
        var matches = false;
        self.debugLog("Testing custom filters (any) for sensor: "+sensor.name);
        for (var filterPath of Object.keys(sensor.customFiltersAnyOf))
        {
            var eventValue = filterPath.split('.').reduce((previous, current) => {
                return previous[current];
            }, event);
            self.debugLog("Testing custom filter: '"+eventValue+"'' in "+filterPath+": "+sensor.customFiltersAnyOf[filterPath]);
            if (sensor.customFiltersAnyOf[filterPath].indexOf(eventValue) > -1)
            {
                self.debugLog("Matched custom filter ("+eventValue+") for sensor: "+sensor.name);
                matches = true;
            }
        }

        if (!matches)
        {
            self.debugLog("Event doesn't match custom filters for sensor: "+sensor.name);
            return;
        }
    }

    // Based upon the activateSensor flag either turn on or turn off the sensor
    if (activateSensor)
    {
        if (typeof this.timeouts[sensor.name] != 'undefined')
        {
            self.debugLog("Clear existing delayed off for: "+sensor.name);
            clearTimeout(this.timeouts[sensor.name])
        }
        if (sensor.activePlayers.size == 0)
        {
            self.debugLog("Event triggered sensor on: "+sensor.name);
        }
        sensor.activePlayers.add(event.Player.uuid);
        sensor.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(true);
    }
    else
    {
        sensor.activePlayers.delete(event.Player.uuid);
        if (sensor.activePlayers.size == 0)
        {
            if (typeof this.timeouts[sensor.name] != 'undefined')
            {
                self.debugLog("Clear existing delayed off for: "+sensor.name);
                clearTimeout(this.timeouts[sensor.name])
            }
            if (sensor.delayOff &&
                sensor.delayOff > 0)
            {
                self.debugLog("Event scheduled sensor off: "+sensor.name+" after "+sensor.delayOff+"ms");
                this.timeouts[sensor.name] = setTimeout(function() {
                    self.debugLog("Event triggered sensor off: "+sensor.name);
                    sensor.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(false);
                }.bind(this), sensor.delayOff);
            }
            else
            {
                self.debugLog("Event triggered sensor off without delay: "+sensor.name);
                sensor.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(false);
            }
        }
    }
}

Plex.prototype.getPlaying = function (callback) {
    callback(null, this.playing);
}

Plex.prototype.getServices = function () {
    var services = [];
    for (var sensor of this.sensors) {
        services.push(sensor.service);
    }
    return services;
}
