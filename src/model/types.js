// Normalized roster model (JSDoc only; no runtime code).
// Every roster source adapter produces a RosterSnapshot; everything downstream (roster,
// state engine, Duty Horizon, UI) consumes only these shapes, never source-specific fields.
//
// Conventions: instants are epoch milliseconds; dates are 'YYYY-MM-DD' in profile.homeTz.

/**
 * @typedef {'off'|'unassigned'|'flight'|'standby'|'reserve'|'layover'|'training'|'positioning'|'unknown'} DutyStatus
 *   unassigned: the roster lists the day with no duty assigned; it is not a day off.
 * @typedef {'confirmed'|'inferred'|'unknown'} Confidence
 *   confirmed: stated by the roster source; inferred: derived from strong evidence; unknown: not provable.
 * @typedef {'source'|'history'|'derived'|'none'} Provenance
 *   source: current payload; history: a sector remembered from an earlier payload; derived: computed by V2.
 */

/**
 * @typedef {Object} Capabilities
 * @property {boolean} sectors           flight sectors with instants
 * @property {boolean} pickup            pickup instants
 * @property {boolean} offDaysByAbsence  days the source reports as free of duty starts (not proof of OFF)
 * @property {boolean} explicitOff       the source states OFF days explicitly
 * @property {boolean} standbyWindows    SB windows with start/end
 * @property {boolean} reserveWindows    RE windows with start/end
 * @property {boolean} pastSectors       sectors before today are included
 * @property {boolean} reportTime        briefing/report instants
 * @property {boolean} hotels            layover hotel records
 * @property {boolean} history           month/year/all-time statistics
 * @property {string[]} actions          backend actions available (sync, dashboard, dashboardPrev)
 */

/**
 * @typedef {Object} Sector
 * @property {string} id
 * @property {string} flightNumber
 * @property {string} origin        IATA
 * @property {string} destination   IATA
 * @property {number} dep           instant
 * @property {number} arr           instant
 * @property {number} blockMin
 * @property {string|null} originTz IANA, null when the airport is unknown
 * @property {string|null} destTz
 * @property {number|null} pickup   only on the first sector of a duty
 * @property {number|null} [report] check-in (report) time, first sector of a duty, when the source states it (v2)
 * @property {{typeCode:string, registration:string|null, provenance:'source'}|null} [aircraft]  optional source metadata (v2)
 * @property {'device'|'roster-calendar'} [historySource]  for remembered sectors: device memory or v2 server history
 * @property {Provenance} provenance
 * @property {Object|null} legacy   v5 display strings, kept only for parity tests
 */

/**
 * @typedef {Object} Window   a standby/reserve/off/unassigned window stated by the source
 * @property {'standby'|'reserve'|'off'|'layover'|'unassigned'} kind  'unassigned': a day with no duty assigned (never an off window)
 * @property {'off'|'free'|'leave'|'ort'} [subtype]  rest family (v2): 'ort' = protected free day
 * @property {boolean} [protected]  protected free day: assigned by the company, not reassignable
 * @property {object|null} [hotel]  roster hotel for a stated layover (v2)
 * @property {number} start
 * @property {number} end
 * @property {string} [label]
 */

/**
 * @typedef {Object} RosterSnapshot
 * @property {{id:string,label:string,kind:'live'|'fixture'|'sample'|'cache',fetchedAt:number}} source
 * @property {Capabilities} capabilities
 * @property {Sector[]} sectors
 * @property {Window[]} windows
 * @property {{start:string,days:number}[]} offBlocks   source-reported free blocks (date keys)
 * @property {string|null} offCoverageEnd               last date the offBlocks list speaks for
 * @property {string|null} [flightCoverageEnd]          last date the sector list speaks for
 * @property {number|null} [flightListLimit]            most sectors the source lists at once (v5: 5)
 * @property {{current:number,nextOffInDays:number,maxThisMonth:number}|null} dutyBlock
 * @property {Object|null} stats
 * @property {Object|null} map
 * @property {Object[]} achievements
 * @property {{code:string,message:string}[]} warnings
 * @property {'v2'} [contract]                          set by the fc.roster v2 adapter
 * @property {Object<string,'rostered'|'empty'|'unpublished'>} [dayStates]  v2 coverage per local date
 * @property {string} [coverageEnd]                     v2 coverage end date
 * @property {object[]} [stays]                         v2 roster-stated stays (hotel blocks)
 * @property {'device'|'roster-calendar'} [historySource]
 */

/**
 * @typedef {Object} Duty
 * @property {string} id
 * @property {DutyStatus} kind
 * @property {Sector[]} sectors
 * @property {number|null} wakeup
 * @property {number|null} pickup
 * @property {number|null} report
 * @property {number} start
 * @property {number} end
 * @property {Confidence} confidence
 * @property {Provenance} provenance
 */

/**
 * @typedef {Object} Layover
 * @property {string} airport
 * @property {number} from
 * @property {number} to
 * @property {Confidence} confidence   always 'inferred': no source states layovers
 * @property {Provenance} provenance   always 'derived'
 */

/**
 * @typedef {Object} OperationalState
 * @property {DutyStatus} status
 * @property {Confidence} confidence
 * @property {Provenance} provenance
 * @property {string} phase        finer phase, e.g. 'airborne', 'pre-departure', 'turnaround', 'post-duty'
 * @property {string|null} location
 * @property {{kind:string,at:number,label:string}|null} nextEvent
 * @property {Duty|null} duty      current, just-completed (post-duty) or next relevant duty
 * @property {Duty|null} nextDuty  the following duty when `duty` is already complete
 * @property {Layover|null} layover
 * @property {Window|null} window
 * @property {string[]} reasons    human-readable evidence trail
 */

/**
 * A flight from an external schedule provider (the `departures` action), normalized by the V2
 * browser adapter. It is NOT a roster sector (it is not in the crew member's roster), NOT an
 * assignment, and NOT a prediction: it only says what the provider currently lists. Never
 * convert it into a Sector or merge it into a RosterSnapshot; it carries no duty, report or
 * pickup concept by design.
 * @typedef {Object} ScheduledFlight
 * @property {string} id                 'f_' + 16 hex, stable for (flightNumber, scheduledDep)
 * @property {string} flightNumber       whitespace-free, uppercase
 * @property {string|null} carrier       two-character airline designator, when known
 * @property {string} origin             IATA; always the requested airport
 * @property {string|null} destination   IATA, null when the provider gives none
 * @property {string|null} destinationName
 * @property {number} scheduledDep       instant (epoch ms); the only time used for window membership
 * @property {number|null} revisedDep    provider's revised instant, informational only
 * @property {'scheduled'|'delayed'|'boarding'|'departed'|'cancelled'|'unknown'} status
 * @property {{model:string|null, registration:string|null}|null} aircraft
 * @property {string|null} originTz      IANA from the V2 airport table, null when the airport is unknown
 * @property {string|null} destTz
 * @property {'provider'} provenance     always 'provider': never roster-confirmed
 */

/**
 * Result of loading departures (src/sources/departures-service.js).
 * @typedef {Object} DeparturesResult
 * @property {string} airport
 * @property {string} airportTz          as stated by the backend for the requested airport
 * @property {number} from               instants (epoch ms), half-open [from, to)
 * @property {number} to
 * @property {ReadonlyArray<string>|null} carriers  the carrier filter applied, null = none
 * @property {string} provider           opaque provider label from the backend
 * @property {number} fetchedAt          oldest provider fetch behind this result
 * @property {number} generatedAt        when the backend built the response
 * @property {number} dropped            provider entries the backend dropped for lacking a usable scheduled time
 * @property {ReadonlyArray<ScheduledFlight>} flights
 * @property {boolean} fromCache         served from the device cache (5 min) instead of a new request
 */

export {};
