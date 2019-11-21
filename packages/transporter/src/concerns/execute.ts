import { createRetryError, Host, MappedRequestOptions, Request, Transporter } from '..';
import { deserializeFailure, deserializeSuccess } from '../deserializer';
import { serializeData, serializeUrl } from '../serializer';
import { StackFrame } from '../types/StackFrame';
import { decision } from './decision';

// eslint-disable-next-line max-params
export function execute<TResponse>(
  transporter: Transporter,
  hosts: readonly Host[],
  request: Request,
  requestOptions: MappedRequestOptions
): Readonly<Promise<TResponse>> {
  let timeoutRetries = 0; // eslint-disable-line functional/no-let

  return Promise.all(
    hosts.map(host =>
      transporter.hostsCache
        .get({ url: host.url }, () => Promise.resolve(host))
        .then((value: Host) => {
          // eslint-disable-next-line functional/immutable-data
          return Object.assign(host, {
            downDate: value.downDate,
            up: value.up,
          });
        })
    )
  ).then(statefulHosts => {
    const statefulHostsAvailable = statefulHosts.filter(host => host.isUp()).reverse();

    // eslint-disable-next-line functional/prefer-readonly-type
    const stackTrace: StackFrame[] = [];

    const forEachHost = <TResponse>(host?: Host): Readonly<Promise<TResponse>> => {
      if (host === undefined) {
        throw createRetryError(stackTrace);
      }

      const payload = {
        data: serializeData(request, requestOptions),
        headers: { ...transporter.headers, ...requestOptions.headers },
        method: request.method,
        url: serializeUrl(host, request.path, {
          ...transporter.queryParameters,
          ...requestOptions.queryParameters,
          'x-algolia-agent': transporter.userAgent.value,
        }),
        timeout: (timeoutRetries + 1) * (requestOptions.timeout ? requestOptions.timeout : 0),
      };

      return transporter.requester.send(payload).then(response =>
        decision(host, response, {
          success: () => deserializeSuccess(response),
          retry: () => {
            // eslint-disable-next-line functional/immutable-data
            stackTrace.push({
              request: payload,
              response,
              host,
              triesLeft: statefulHostsAvailable.length,
              timeoutRetries,
            });

            return (
              transporter.logger
                .debug('Retryable failure', stackTrace[stackTrace.length - 1])
                .then(() => {
                  if (response.isTimedOut) {
                    timeoutRetries++;
                  }

                  return transporter.hostsCache.set({ url: host.url }, host);
                })
                // eslint-disable-next-line functional/immutable-data
                .then(() => forEachHost(statefulHostsAvailable.pop()))
            );
          },
          fail: () => {
            throw deserializeFailure(response);
          },
        })
      );
    };

    // eslint-disable-next-line functional/immutable-data
    return forEachHost(statefulHostsAvailable.pop());
  });
}