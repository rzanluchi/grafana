define([
  'angular',
  'lodash',
  'kbn',
  'moment',
  './prestoSeries',
  './prestoQueryBuilder',
  './localGrafanaDB'
],
function (angular, _, kbn, moment, PrestoSeries, PrestoQueryBuilder) {
  'use strict';

  var module = angular.module('grafana.services');

  module.factory('PrestoDatasource', function($q, $http, templateSrv, timeSrv, LocalStorageDatasource, $timeout) {

    function PrestoDatasource(datasource) {
      this.type = 'prestoDB';
      this.editorSrc = 'app/partials/prestodb/editor.html';
      this.urls = datasource.urls;
      this.username = datasource.username;
      this.password = datasource.password;
      this.name = datasource.name;

      this.saveTemp = _.isUndefined(datasource.save_temp) ? true : datasource.save_temp;
      this.saveTempTTL = _.isUndefined(datasource.save_temp_ttl) ? '30d' : datasource.save_temp_ttl;

      this.grafanaDB = datasource.grafanaDB;
      this.supportAnnotations = true;
      this.supportMetrics = true;
      this.annotationEditorSrc = 'app/partials/prestodb/annotation_editor.html';
      // presto module attrs
      this.requestHeaders = datasource.requestHeaders;
      this.timeField = datasource.time_field;
      this.rest_api_path = datasource.rest_api_path;
      this.pseudonow = datasource.pseudonow;
      this.sinceDate = moment(this.pseudonow).subtract('days', 30).format("YYYY-MM-DD hh:mm:ss");
      this.now = "date_parse('" + this.pseudonow + "', '%Y-%m-%e %H:%i:%s')";
      this.timeFieldIsString =  _.isUndefined(datasource.time_field_is_string) ?
        true : datasource.time_field_is_string;

      if (this.timeFieldIsString) {
        this.timeFieldStatement = "date_parse(" + this.timeField + ", '%Y-%m-%e %H:%i:%s')";
      } else {
        this.timeFieldStatement = this.timeField;
      }

      this.localGrafanaDB = new LocalStorageDatasource();
      this.cache = { columns: {} };
    }

    PrestoDatasource.prototype.query = function(options) {

      // Use pseudo now config as current date
      setPseudoNow(timeSrv, this.pseudonow || moment().format("YYYY-MM-DD hh:mm:ss"));
      options.range = timeSrv.timeRange(false);

      var timeFilter = getTimeFilter(this.timeFieldStatement, this.now, this.pseudonow, options);

      this.sinceDate = timeFilter[1].format("YYYY-MM-DD hh:mm:ss");

      var promises = _.map(options.targets, function(target) {
        if (target.hide || !((target.series && target.column) || target.query)) {
          return [];
        }

        target.timefield = this.timeField;

        // build query
        var queryBuilder = new PrestoQueryBuilder(target);
        var query = queryBuilder.build();

        // replace grafana variables
        query = query.replace('$timeFilter', timeFilter[0]);

        var prestoInterval = getPrestoInterval(this.sinceDate, this.timeFieldStatement, target.interval || options.interval);
        var prestoIntervalState = prestoInterval[0];
        var intervalSeconds = prestoInterval[1];

        query = query.replace('$interval', prestoIntervalState);
        query = query.replace('$datetrunc', prestoIntervalState);

        query += " order by " + prestoIntervalState + " asc";

        // replace templated variables
        query = templateSrv.replace(query);

        console.log("query: " + query);

        var alias = target.alias ? templateSrv.replace(target.alias) : '';

        var handleResponse = _.partial(handlePrestoQueryResponse, alias,
          queryBuilder.groupByField, this.sinceDate, this.pseudonow, intervalSeconds);
        return this._seriesQuery(query).then(handleResponse);

      }, this);

      return $q.all(promises).then(function(results) {
        return { data: _.flatten(results) };
      });
    };

    PrestoDatasource.prototype.annotationQuery = function(annotation, rangeUnparsed) {

      setPseudoNow(timeSrv, this.pseudonow || moment().format("YYYY-MM-DD hh:mm:ss"));
      rangeUnparsed = timeSrv.timeRange(false);

      var timeFilter = getTimeFilter(this.timeFieldStatement, this.now, this.pseudonow, { range: rangeUnparsed });
      var query = annotation.query.replace('$timeFilter', timeFilter[0]);
      query = query.replace('select', "select to_unixtime(" + this.timeFieldStatement + ") as time,");
      query = templateSrv.replace(annotation.query);

      return this._seriesQuery(query).then(function(results) {
        return new PrestoSeries({ seriesList: results, annotation: annotation }).getAnnotations();
      });
    };

    PrestoDatasource.prototype.listColumns = function(seriesName) {
      var self = this;
      if (self.cache.columns[seriesName]) {
        return self.cache.columns[seriesName];
      } else {
        return this._seriesQuery('select * from ' + seriesName + ' limit 1').then(function(data) {
          if (!data) {
            return [];
          }
          var columns = _.map(data.columns, function(column) {
            return column.name;
          });
          self.cache.columns[seriesName] = columns;
          return columns;
        });
      }
    };

    PrestoDatasource.prototype.listSeries = function() {
      var self = this;
      if (self.cache.series) {
        return self.cache.series;
      } else {
        return this._seriesQuery('show tables').then(function(data) {
          console.log("data, ", data);
          if (!data || data.length === 0) {
            return [];
          } else {
            var series = _.map(data.data, function(item) {
              return item[0];
            });
            self.cache.series = series;
            return series;
          }
        });
      }
    };

    PrestoDatasource.prototype.metricFindQuery = function (query) {
      var interpolated;
      try {
        interpolated = templateSrv.replace(query);
      }
      catch (err) {
        return $q.reject(err);
      }

      return this._seriesQuery(interpolated)
        .then(function (results) {
          return _.map(results[0].points, function (metric) {
            return {
              text: metric[1],
              expandable: false
            };
          });
        });
    };

    function setPseudoNow(timeSrv, pseudonow) {

      var range = timeSrv.timeRange();
      var rangeUnparsed = timeSrv.timeRange(false);

      if (rangeUnparsed.to === 'now') {
        range.to = moment(pseudonow).toDate();

        var diff = moment().unix() - moment(pseudonow).unix();
        range.from = moment(range.from).subtract('seconds', diff).toDate();

        timeSrv.setTime(range);

      }
    }

    function retry(deferred, callback, delay) {
      return callback().then(undefined, function(reason) {
        if (reason.status !== 0 || reason.status >= 300) {
          reason.message = 'PrestoDB Error: <br/>' + reason.data;
          deferred.reject(reason);
        }
        else {
          setTimeout(function() {
            return retry(deferred, callback, Math.min(delay * 2, 30000));
          }, delay);
        }
      });
    }

    PrestoDatasource.prototype._seriesQuery = function(query) {
      return this._prestoRequest('POST', this.rest_api_path, query);
      //return this._prestoRequest('POST', '/', "query=" + query + ";&db=presto");
    };

    PrestoDatasource.prototype._prestoRequest = function(method, url, data) {
      var _this = this;
      var deferred = $q.defer();

      retry(deferred, function() {
        var currentUrl = _this.urls.shift();
        _this.urls.push(currentUrl);

        var params = {
          u: _this.username,
          p: _this.password,
        };

        if (method === 'GET') {
          _.extend(params, data);
          data = null;
        }

        var options = {
          method: method,
          url:    currentUrl + url,
          data:   data,
          headers: _this.requestHeaders,
          inspect: { type: 'prestodb' },
        };

        return $http(options).success(function (data) {
          handleAsyncPrestoApiCall(data, deferred);
        });
      }, 10);

      return deferred.promise;
    };

    PrestoDatasource.prototype.saveDashboard = function(dashboard) {
      var tags = dashboard.tags.join(',');
      var title = dashboard.title;
      var temp = dashboard.temp;
      var id = kbn.slugifyForUrl(title);
      dashboard.id = id;
      if (temp) { delete dashboard.temp; }

      var data = [{
        name: 'grafana.dashboard_' + btoa(id),
        id: id,
        title: title,
        tags: tags,
        dashboard: angular.toJson(dashboard)
      }];

      if (temp) {
        return this._saveDashboardTemp(data, title, id);
      }
      else {
        var self = this;
        return self.localGrafanaDB._saveDashboard(id, title, tags, data).then(function() {
          return { title: title, url: '/dashboard/db/' + id };
        }, function(err) {
          throw 'Failed to save dashboard to LocalStorage for PrestoDB: ' + err.data;
        });
      }
    };

    PrestoDatasource.prototype._saveDashboardTemp = function() {//data, title) {
      // save menu -> share temp copy
      console.log("Sorry, this do not work and needs refactor");
      //data[0].name = 'grafana.temp_dashboard_' + btoa(title);
      //data[0].columns.push('expires');
      //data[0].points[0].push(this._getTempDashboardExpiresDate());

      //return this._prestoRequest('POST', '/series', data).then(function() {
      //  var baseUrl = window.location.href.replace(window.location.hash,'');
      //  var url = baseUrl + "#dashboard/temp/" + title;
      //  return { title: title, url: url };
      //}, function(err) {
      //  throw 'Failed to save shared dashboard to PrestoDB: ' + err.data;
      //});

    };

    PrestoDatasource.prototype._getTempDashboardExpiresDate = function() {
      var ttlLength = this.saveTempTTL.substring(0, this.saveTempTTL.length - 1);
      var ttlTerm = this.saveTempTTL.substring(this.saveTempTTL.length - 1, this.saveTempTTL.length).toLowerCase();
      var expires = Date.now();
      switch(ttlTerm) {
        case "m":
          expires += ttlLength * 60000;
          break;
        case "d":
          expires += ttlLength * 86400000;
          break;
        case "w":
          expires += ttlLength * 604800000;
          break;
        default:
          throw "Unknown ttl duration format";
      }
      return expires;
    };

    PrestoDatasource.prototype.getDashboard = function(id) {//, isTemp) {
      var query = {'id': id};

      //if (isTemp) {
      //}

      return this.localGrafanaDB._getDashboard(query).then(function(results) {
        if (!results || !results.length) {
          throw "Dashboard not found";
        }

        var dashJson = results[0]['dashboard'];

        return angular.fromJson(dashJson);
      }, function(err) {
        return "Could not load dashboard, " + err.data;
      });
    };

    PrestoDatasource.prototype.deleteDashboard = function(id) {
      return this.localGrafanaDB._deleteDashboard(id).then(function(results) {
        if (!results) {
          throw "Could not delete dashboard";
        }
        return id;
      }, function(err) {
        return "Could not delete dashboard, " + err.data;
      });
    };

    PrestoDatasource.prototype.searchDashboards = function(queryString) {
      var localStorageQuery = {};

      var tagsOnly = queryString.indexOf('tags!:') === 0;
      if (tagsOnly) {
        var tagsQuery = queryString.substring(6, queryString.length);
        localStorageQuery['tag'] = new RegExp('.*' + tagsQuery + '.*', 'i');
      }
      else {
        var titleOnly = queryString.indexOf('title:') === 0;
        if (titleOnly) {
          var titleQuery = queryString.substring(6, queryString.length);
          localStorageQuery['title'] = new RegExp('.*' + titleQuery + '.*', 'i');
        }
        else {
          localStorageQuery['tag'] = new RegExp('.*' + queryString + '.*', 'i');
          localStorageQuery['title'] = new RegExp('.*' + queryString + '.*', 'i');
        }
      }

      return this.localGrafanaDB._searchDashboards(localStorageQuery).then(function(results) {
        var hits = { dashboards: [], tags: [], tagsOnly: false };

        console.log(results);

        if (!results || !results.length) {
          return hits;
        }

        for (var i = 0; i < results.length; i++) {
          var hit =  {
            id: results[i]['id'],
            title: results[i]['title'],
            tags: results[i]['tags'].split(',')
          };
          hit.tags = hit.tags[0] ? hit.tags : [];
          hits.dashboards.push(hit);
        }
        return hits;
      });
    };

    function handleAsyncPrestoApiCall(request, promise) {
      if (request.data) {
        promise.resolve(request);
      } else if (request.nextUri) {
        $timeout(function() {
          if (request.nextUri) {
            $http.get(request.nextUri).success(function(data) {
              handleAsyncPrestoApiCall(data, promise);
            });
          }
        }, 2000);
      } else {
        // the query returned 0 results
        promise.resolve({
          data: [],
          columns: []
        });
      }
    }

    function handlePrestoQueryResponse(alias, groupByField, sinceDate, pseudoNowDate, intervalSeconds, seriesList) {
      var prestoSeries = new PrestoSeries({
        seriesList: seriesList,
        alias: alias,
        groupByField: groupByField,
        sinceDate: sinceDate,
        pseudoNowDate: pseudoNowDate,
        intervalSeconds: intervalSeconds,
      });

      return prestoSeries.getTimeSeries();
    }

    function getTimeFilter(timeFieldStatement, nowStr, pseudoNowDate, options) {
      var from = getPrestoTime(options.range.from);
      var until = getPrestoTime(options.range.to);

      if (until === 'now()') {
        from = getPrestoTimeDetails(from, pseudoNowDate);
        return [timeFieldStatement + " > " +
        "date_parse('" + from.format("YYYY-MM-DD hh:mm:ss") + "', '%Y-%m-%e %H:%i:%s')", from];
      }

      var parsedFrom = parseIntervalString(from);
      var parsedUntil = parseIntervalString(until);

      return ["to_unixtime(" + timeFieldStatement + ") > " + parsedFrom[0] +
      " and to_unixtime(" + timeFieldStatement + ") < " + parsedUntil[0], moment.unix(parsedFrom[0])];
    }

    function parseIntervalString(interval) {
      var patt = new RegExp("(\\d*)(\\w)");
      var res = patt.exec(interval);

      var unit_word = '';
      switch (res[2]) {
        case 's':
          unit_word = 'second';
          break;
        case 'm':
          unit_word = 'minute';
          break;
        case 'h':
          unit_word = 'hour';
          break;
        case 'd':
          unit_word = 'day';
          break;
      }
      return [res[1], unit_word];
    }

    function getPrestoInterval(sinceDate, timeFieldStatement, intervalStr) {

      var interval = parseIntervalString(intervalStr);

      var value = interval[0];
      var unit_word = interval[1];

      var intervalSeconds = 0;
      switch (unit_word) {
        case 'second':
          intervalSeconds = value;
          break;
        case 'minute':
          intervalSeconds = value * 60;
          break;
        case 'hour':
          intervalSeconds = value * 60 * 60;
          break;
        case 'day':
          intervalSeconds = value * 60 * 60 * 24;
          break;
      }

      return ["floor((to_unixtime(" + timeFieldStatement +
      ") - to_unixtime(date_parse('" + sinceDate +
      "', '%Y-%m-%e %H:%i:%s'))) / (" + intervalSeconds + "))", intervalSeconds];
      //" + to_unixtime(date_parse('" + sinceDate + "', '%Y-%m-%e %H:%i:%s'))";
    }

    function getPrestoTimeDetails(fromDate, pseudoNowDate) {

      var interval = parseIntervalString(fromDate);

      var value = interval[0];
      var unit_word = interval[1];

      return moment(pseudoNowDate).subtract(unit_word, value);
    }

    function getPrestoTime(date) {
      if (_.isString(date)) {
        if (date === 'now') {
          return 'now()';
        }
        else if (date.indexOf('now') >= 0) {
          return date.substring(4);
        }

        date = kbn.parseDate(date);
      }

      return to_utc_epoch_seconds(date);
    }

    function to_utc_epoch_seconds(date) {
      return (date.getTime() / 1000).toFixed(0) + 's';
    }

    return PrestoDatasource;

  });

});
