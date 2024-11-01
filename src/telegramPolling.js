const errors = require('./errors');
const debug = require('debug')('bot_telegram');
const deprecate = require('./utils').deprecate;
const ANOTHER_WEB_HOOK_USED = 409;

class TelegramBotPolling {
  constructor(bot) {
    this.bot = bot;
    this.options = (typeof bot.options.polling === 'boolean') ? {} : bot.options.polling;
    this.options.interval = (typeof this.options.interval === 'number') ? this.options.interval : 300;
    this.options.params = (typeof this.options.params === 'object') ? this.options.params : {};
    this.options.params.offset = (typeof this.options.params.offset === 'number') ? this.options.params.offset : 0;
    this.options.params.timeout = (typeof this.options.params.timeout === 'number') ? this.options.params.timeout : 10;
    
    // Log de aviso de depreciação
    if (typeof this.options.timeout === 'number') {
      deprecate('`options.polling.timeout` is deprecated. Use `options.polling.params` instead.');
      this.options.params.timeout = this.options.timeout;
    }
    
    this._lastUpdate = 0;
    this._lastRequest = null;
    this._abort = false;
    this._pollingTimeout = null;

    // Novo: adicionar controle de fluxo
    this._isPollingActive = false;
  }

  /**
   * Start polling
   * @param  {Object} [options]
   * @param  {Object} [options.restart]
   * @return {Promise}
   */
  start(options = {}) {
    if (this._isPollingActive) {
      if (!options.restart) {
        return Promise.resolve();
      }
      // Emitir evento de reinício de polling
      this.bot.emit('polling_restart', 'Polling restart initiated');
      return this.stop({ cancel: true, reason: 'Polling restart' })
        .then(() => this._polling());
    }

    // Emitir evento de início de polling
    this.bot.emit('polling_started', 'Polling started');
    this._isPollingActive = true;
    return this._polling();
  }

  /**
   * Stop polling
   * @param  {Object} [options] Options
   * @param  {Boolean} [options.cancel] Cancel current request
   * @param  {String} [options.reason] Reason for stopping polling
   * @return {Promise}
   */
  stop(options = {}) {
    if (!this._lastRequest) {
      return Promise.resolve();
    }
    const lastRequest = this._lastRequest;
    this._lastRequest = null;
    clearTimeout(this._pollingTimeout);
    if (options.cancel) {
      const reason = options.reason || 'Polling stop';
      lastRequest.cancel(reason);
      // Emitir evento de parada de polling
      this.bot.emit('polling_stopped', 'Polling stopped');
      this._isPollingActive = false;
      return Promise.resolve();
    }
    this._abort = true;
    return lastRequest.finally(() => {
      this._abort = false;
      this._isPollingActive = false;
      this.bot.emit('polling_stopped', 'Polling stopped');
    });
  }

  /**
   * Return `true` if polling is active. Otherwise, `false`.
   */
  isPolling() {
    return !!this._lastRequest;
  }

  /**
   * Handle error thrown during polling.
   * @private
   * @param  {Error} error
   */
  _error(error) {
    if (!this.bot.listeners('polling_error').length) {
      console.error('error: [polling_error] %j', error); // eslint-disable-line no-console
    } else {
      this.bot.emit('polling_error', error);
    }
  }

  /**
   * Improved error handling for infinite loop issues.
   * @private
   * @param  {Error} err
   */
  _handleProcessingError(err) {
    if (!this.bot.options.badRejection) {
      return this._error(err);
    }
    const opts = { offset: this.options.params.offset, limit: 1, timeout: 0 };
    return this.bot.getUpdates(opts)
      .then(() => this._error(err))
      .catch(requestErr => {
        console.error('error: Internal handling of The Offset Infinite Loop failed');
        console.error(`error: Due to error '${requestErr}'`);
        console.error('error: You may receive already-processed updates on app restart');
        this.bot.emit('error', new errors.FatalError(err));
      });
  }

  /**
   * Main polling loop with recursion and flow control.
   * @return {Promise}
   * @private
   */
  _polling() {
    this._lastRequest = this._getUpdates()
      .then(updates => {
        this._lastUpdate = Date.now();
        debug('polling data %j', updates);

        // Process each update
        updates.forEach(update => {
          this.options.params.offset = update.update_id + 1;
          debug('updated offset: %s', this.options.params.offset);
          try {
            this.bot.processUpdate(update);
          } catch (err) {
            err._processing = true;
            throw err;
          }
        });
        return null;
      })
      .catch(err => {
        debug('polling error: %s', err.message);
        if (!err._processing) {
          return this._error(err);
        }
        delete err._processing;
        return this._handleProcessingError(err);
      })
      .finally(() => {
        if (this._abort) {
          debug('Polling is aborted!');
        } else {
          debug('setTimeout for %s milliseconds', this.options.interval);
          this._pollingTimeout = setTimeout(() => this._polling(), this.options.interval);
        }
      });

    return this._lastRequest;
  }

  /**
   * Unset current webhook and switch to polling.
   * @private
   */
  _unsetWebHook() {
    debug('unsetting webhook');
    return this.bot._request('setWebHook');
  }

  /**
   * Retrieve updates from Telegram API.
   * @private
   * @return {Promise}
   */
  _getUpdates() {
    debug('polling with options: %j', this.options.params);
    return this.bot.getUpdates(this.options.params)
      .catch(err => {
        if (err.response && err.response.statusCode === ANOTHER_WEB_HOOK_USED) {
          return this._unsetWebHook().then(() => this.bot.getUpdates(this.options.params));
        }
        throw err;
      });
  }
}

module.exports = TelegramBotPolling;
