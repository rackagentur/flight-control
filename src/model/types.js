// Normalized roster model (JSDoc only; no runtime code).
// Every roster source adapter produces a RosterSnapshot; everything downstream (roster,
// state engine, Duty Horizon, UI) consumes only these shapes, never source-specific fields.
//
// Conventions: instants are epoch milliseconds; dates are 'YYYY-MM-DD' in profile.homeTz.

/**
 * @typedef {'off'|'flight'|'standby'|'reserve'|'layover'|'training'|'positioning'|'unknown'} DutyStatus
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
 * @property {Provenance} provenance
 * @property {Object|null} legacy   v5 display strings, kept only for parity tests
 */

/**
 * @typedef {Object} Window   a standby/reserve/off window stated by the source
 * @property {'standby'|'reserve'|'off'|'layover'} kind
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

export {};
