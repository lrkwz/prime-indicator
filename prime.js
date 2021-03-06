/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

// strict mode
'use strict';

// import modules
const Gio = imports.gi.Gio;
const Signals = imports.signals;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Log = Me.imports.log;

/**
 * Switch constructor:
 * prime profiles manipulation
 *
 * @param  {Object}
 * @return {Object}
 */
var Switch = class Switch {

    /**
     * Constructor
     *
     * @return {Void}
     */
    constructor() {
        this._commands = null;
        this._gpu = null;
        this._listener = null;

        this._commands = {
            sudo: this._which('pkexec') || this._which('gksudo'),
            select: this._which('prime-select'),
            management: this._which('nvidia-smi'),
            settings: this._which('nvidia-settings'),
        }
    }

    /**
     * Destructor
     *
     * @return {Void}
     */
    destroy() {
        this.unmonitor();
    }

    /**
     * Proxy for global.log()
     *
     * @param  {String} message
     * @return {Void}
     */
    _log(message) {
        let args = Array.prototype.slice.call(arguments);
        args.unshift('Prime.Switch');

        Log.journal.apply(Log.journal, args);
    }

    /**
     * `which $command` result
     *
     * @param  {String} command
     * @return {Mixed}
     */
    _which(command) {
        let exec = this._shell_exec('which ' + command);
        return exec.stdout.trim() || exec.stderr.trim();
    }

    /**
     * Shell execute command
     *
     * @param  {String} command
     * @return {Object}
     */
    _shell_exec(command) {
        let result = {
            status: -1,
            stdin: command,
            stdout: '',
            stderr: '',
        }

        try {
            let subprocess = new Gio.Subprocess({
                argv: command.split(' '),
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            subprocess.init(null);

            let [, stdout, stderr] = subprocess.communicate_utf8(null, null);
            result.status = subprocess.get_exit_status();;
            result.stdout = stdout;
            result.stderr = stderr;
        }
        catch(e) {
            result.stderr = e.toString();
        }

        return result;
    }

    /**
     * Shell execute command
     *
     * @param  {String}   command
     * @param  {Function} callback (optional)
     * @return {Void}
     */
    _shell_exec_async(command, callback) {
        try {
            let subprocess = new Gio.Subprocess({
                argv: command.split(' '),
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });

            subprocess.init(null);
            subprocess.communicate_utf8_async(null, null, function(source, resource) {
                let status = source.get_exit_status();
                let [, stdout, stderr] = source.communicate_utf8_finish(resource);

                if (typeof callback === 'function')
                    callback.call(this, {
                        status: status,
                        stdin: command,
                        stdout: stdout,
                        stderr: stderr,
                    });
            }.bind(this));
        }
        catch(e) {
            if (typeof callback === 'function')
                callback.call(this, {
                    status: -1,
                    stdin: command,
                    stdout: '',
                    stderr: e.toString(),
                });
        }
    }

    /**
     * File with prime status
     *
     * @type {String}
     */
    get index() {
        return '/etc/prime-discrete';
    }

    /**
     * Property gpu getter:
     * if `nvidia-smi -q` shell command exit code
     * is non-zero, 'nvidia' is not in use
     *
     * @return {String}
     */
    get gpu() {
        if (this._gpu)
            return this._gpu;

        let cmd = this.command('management');
        if (cmd) {
            let exec = this._shell_exec(cmd + ' -L');
            this._gpu = exec.status ? 'intel' : 'nvidia';
        }
        else
            this._gpu = 'unknown';

        return this.gpu;
    }

    /**
     * Property query getter:
     * shell command `prime-select query` result
     *
     * @return {String}
     */
    get query() {
        let cmd = this.command('select');
        if (cmd) {
            let exec = this._shell_exec(cmd + ' query');
            return exec.stdout.trim() || exec.stderr.trim() || 'unknown';
        }

        return 'unknown';
    }

    /**
     * Get shell command
     *
     * @param  {String} cmd sudo|select|management|settings
     * @return {String}     null on fail
     */
    command(cmd) {
        if (cmd in this._commands)
            return this._commands[cmd];

        return null;
    }

    /**
     * GPU switch
     * shell command `prime-select $gpu`, where
     * gpu is 'intel' or 'nvidia'
     *
     * @param  {String}   gpu    intel|nvidia
     * @param  {Function} logout (optional)
     * @return {Void}
     */
    switch(gpu, callback) {
        let sudo = this.command('sudo');
        if (!sudo)
            return;

        let select = this.command('select');
        if (!select)
            return;

        if (this.query === gpu)
            return;

        let cmd = sudo
             + ' ' + select
             + ' ' + gpu

        this._log('switching to ' + gpu);
        this._shell_exec_async(cmd, function(e) {
            if (!e.status)
                this._log('switched to ' + gpu);
            else
                this._log('not switched to ' + gpu + ' (' + e.stderr.trim() + ')');

            if (typeof callback === 'function')
                callback.call(this, {
                    gpu: gpu,
                    result: !e.status,
                });
        }.bind(this));
    }

    /**
     * Start nvidia-settings
     *
     * @return {Void}
     */
    settings() {
        let cmd = this.command('settings');
        if (!cmd)
            return;

        this._shell_exec_async(cmd);
    }

    /**
     * Start file monitoring
     *
     * @return {Void}
     */
    monitor() {
        if (this._listener)
            return;

        this._listener = Gio.File.new_for_path(this.index).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._listener.connect('changed', this._handle_listener.bind(this));
    }

    /**
     * Stop file monitoring
     *
     * @return {Void}
     */
    unmonitor() {
        if (!this._listener)
            return;

        this._listener.cancel();
        this._listener = null;
    }

    /**
     * File monitor change event handler
     *
     * @param  {Object} file
     * @param  {Object} otherFile
     * @param  {Object} eventType
     * @return {Void}
     */
    _handle_listener(file, otherFile, eventType) {
        this.emit('gpu-change', this.gpu);
    }

    /**
     * Async shell exec event handler
     *
     * @param  {Gio.Subprocess} source
     * @param  {Gio.Task}       resource
     * @param  {String}         stdin
     * @param  {Function}       callback (optional)
     * @return {Void}
     */
    _handle_async_shell_exec(source, resource, stdin, callback) {
        let status = source.get_exit_status();
        let [, stdout, stderr] = source.communicate_utf8_finish(resource);

        if (typeof callback === 'function')
            callback.call(this, {
                status: status,
                stdin: stdin,
                stdout: stdout,
                stderr: stderr,
            });
    }

    /* --- */

};

Signals.addSignalMethods(Switch.prototype);
