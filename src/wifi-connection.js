
var sprintf       = require('sprintf-js').sprintf;
var Events        = require('events');
var ChildProcess  = require('child_process');

function debug() {
};

function isType(obj, type) {
    return Object.prototype.toString.call(obj) == '[object ' + type + ']';
};

function isString(obj) {
    return isType(obj, 'String');
};

 function isFunction(obj) {
    return typeof obj === 'function';
};


module.exports = class WiFiConnection {

    constructor(options) {

        if (isString(options))
            options = {iface:options};

        options = Object.assign({iface:'wlan0'}, options);

        if (options.debug) {
            if (isFunction(options.debug)) {
                debug = options.debug;
            }
            else {
                debug = function() {
                    console.log.apply(this, arguments);
                };
            }
        }

        this.iface = options.iface;
    }

    wpa_cli(command, pattern) {

        return new Promise((resolve, reject) => {

            ChildProcess.exec(sprintf('sudo wpa_cli -i %s %s', this.iface, command), (error, stdout, stderr) => {
                if (error)
                    reject(error);
                else {
                    var output = stdout.trim();

                    if (pattern) {
                        var match = output.match(pattern);

                        if (match) {
                            if (match[1])
                                resolve(match[1]);
                            else
                                resolve();
                        }
                        else {
                            reject(new Error(sprintf('Could not parse reply from wpa_cli %s: "%s"', command, output)));

                        }

                    }
                    else {
                        resolve(output);
                    }
                }
            });
        });
    }

    getState() {
        return new Promise((resolve, reject) => {

            this.getStatus().then((status) => {
                resolve(isString(status.ipAddress));
            })

            .catch((error) => {
                reject(error);
            })
        });
    }

    getStatus() {
        debug('getStatus()');
        return new Promise(async (resolve, reject) => {
            var status = {
                interface: this.iface
            };

            let output = await this.wpa_cli('status');
            debug('getStatus: status output=' + JSON.stringify(output));
            let match;
            if ((match = output.match(/\b[^b]ssid=([^\n]+)/))) {
                status.ssid = match[1];
            }

            if ((match = output.match(/\bip_address=([^\n]+)/))) {
                status.ipAddress = match[1];
            }

            if ((match = output.match(/\baddress=([^\n]+)/))) {
                status.macAddress = match[1];
            }

            output = await this.wpa_cli('signal_poll');
            debug('getStatus: signal_poll output=' + JSON.stringify(output));
            if ((match = output.match(/RSSI=([^\n]+)/))) {
                status.signalLevel = parseInt(match[1]);
            }

            resolve(status);

        });

    }



    getNetworks() {
        return new Promise((resolve, reject) => {

            this.wpa_cli('list_networks').then((output) => {

                output = output.split('\n');

                // Remove header
                output.splice(0, 1);

                var networks = [];

                output.forEach((line) => {
                    var params = line.split('\t');
                    networks.push({
                        id   : parseInt(params[0]),
                        ssid : params[1]
                    });

                });

                resolve(networks);
            })
            .catch((error) => {
                reject(error);
            })
        });

    }

    connect(options) {

        options = Object.assign({timeout:60000}, options);

        var self     = this;
        var ssid     = options.ssid;
        var password = options.psk;
        var timeout  = options.timeout;
        var hidden   = options.hidden;

        function delay(ms) {
            return new Promise((resolve, reject) => {
                setTimeout(resolve, ms);
            });
        }

        function addNetwork() {
            debug('Adding network...');

            return new Promise((resolve, reject) => {
                self.wpa_cli('add_network', '^([0-9]+)').then((id) => {
                    resolve(parseInt(id));
                })
                .catch((error) => {
                    reject(error);
                });

            });
        }


        function setNetwork(id, name, value) {
            debug(sprintf('Setting variable %s=%s for network %d.', name, value, id));
            if (typeof value === 'number') {
                return self.wpa_cli(sprintf('set_network %d %s %d', id, name, value), '^OK');
            } else {
                return self.wpa_cli(sprintf('set_network %d %s \'"%s"\'', id, name, value), '^OK');
            }
        }


        function selectNetwork(id) {
            debug(sprintf('Selecting network %d...', id));
            return self.wpa_cli(sprintf('select_network %s', id), '^OK');
        }

        function reconfigure() {
            debug(sprintf('Reconfiguring...'));
            return self.wpa_cli(sprintf('reconfigure'), '^OK');
        }

        function saveConfiguration() {
            debug(sprintf('Saving configuration...'));
            return self.wpa_cli(sprintf('save_config'), '^OK');
        }

        function removeNetwork(id) {
            debug(sprintf('Removing network %d...', id));
            self.wpa_cli(sprintf('remove_network %d', id), '^OK');
        }

        function waitForNetworkConnection(timeout, timestamp) {

            if (timestamp == undefined)
                timestamp = new Date();

            return new Promise((resolve, reject) => {

                self.getStatus().then((status) => {

                    debug(sprintf('Connection status ssid=%s ipAddress=%s ...', status.ssid || '', status.ipAddress || ''));
                    
                    if (isString(status.ipAddress) && status.ssid == ssid) {
                        return Promise.resolve();
                    }
                    else {
                        var now = new Date();

                        if (now.getTime() - timestamp.getTime() < timeout) {
                            return delay(1000).then(() => {
                                return waitForNetworkConnection(timeout, timestamp);
                            })
                        }
                        else {
                            throw new Error('Unable to connect to network.');
                        }
                    }
                })

                .then(() => {
                    resolve();
                })
                .catch((error) => {
                    reject(error);
                });

            });

        }


        function removeExistingNetworks() {

            debug(sprintf('Removing previous networks with the same ssid "%s"...', ssid));

            return new Promise((resolve, reject) => {
                self.getNetworks().then((networks) => {

                    networks = networks.filter((network) => {
                        return network.ssid == ssid;
                    });

                    var promise = Promise.resolve();

                    networks.forEach((network) => {
                        promise = promise.then(() => {
                            return removeNetwork(network.id);
                        });
                    });

                    promise.then(() => {
                        resolve();
                    })
                    .catch((error) => {
                        reject(error);
                    })
                });
            });

        }

        return new Promise((resolve, reject) => {

            var networkID = undefined;

            removeExistingNetworks().then(() => {
                return addNetwork();
            })
            .then((id) => {
                networkID = id;
                return setNetwork(networkID, 'ssid', ssid);
            })
            .then(() => {
                return (isString(password) ? setNetwork(networkID, 'psk', password) : Promise.resolve());
            })
            .then(() => {
                return hidden ? setNetwork(networkID, 'scan_ssid', 1) : Promise.resolve();
            })
            .then(() => {
                return selectNetwork(networkID);
            })
            .then(() => {
                return waitForNetworkConnection(timeout);
            })
            .then(() => {
                return saveConfiguration();
            })
            .then(() => {
                resolve();
            })
            .catch((error) => {
                // Undo all changes
                reconfigure();

                reject(error);
            })
        });

    }

    scan() {
        var self = this;

        function scan() {
            debug('Scan ssids');
            return self.wpa_cli('scan');
        }

        function scan_results() {
            debug('Ssids scan results');
            return self.wpa_cli('scan_results');
        }

        return new Promise((resolve, reject) => {

            scan().then((ssid) => {
                return scan_results();
            })
            .then((output) => {
                output = output.split('\n');
                output.splice(0, 1);

                var ssids = [];

                output.forEach((line) => {
                    debug('line=%o', line);
                    var params = line.split('\t');
                    ssids.push({
                        bssid         : params[0],
                        frequency     : parseInt(params[1]),
                        signalLevel   : parseInt(params[2]),
                        flags         : params[3],
                        ssid          : params[4]
                    });
                });
                resolve(ssids);
            })
            .catch((error) => {
                reject(error);
            })
        });
    }
}
