// @ts-nocheck
/* tslint:disable */
/* eslint-disable */
/**
 * API
 * Audius V1 API
 *
 * The version of the OpenAPI document: 1.0
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */

import {
    Activity,
    ActivityFromJSON,
    ActivityFromJSONTyped,
    ActivityToJSON,
} from './Activity';
import {
    VersionMetadata,
    VersionMetadataFromJSON,
    VersionMetadataFromJSONTyped,
    VersionMetadataToJSON,
} from './VersionMetadata';

/**
 * 
 * @export
 * @interface HistoryResponse
 */
export interface HistoryResponse 
    {
        /**
        * 
        * @type {number}
        * @memberof HistoryResponse
        */
        latest_chain_block: number;
        /**
        * 
        * @type {number}
        * @memberof HistoryResponse
        */
        latest_indexed_block: number;
        /**
        * 
        * @type {number}
        * @memberof HistoryResponse
        */
        latest_chain_slot_plays: number;
        /**
        * 
        * @type {number}
        * @memberof HistoryResponse
        */
        latest_indexed_slot_plays: number;
        /**
        * 
        * @type {string}
        * @memberof HistoryResponse
        */
        signature: string;
        /**
        * 
        * @type {string}
        * @memberof HistoryResponse
        */
        timestamp: string;
        /**
        * 
        * @type {VersionMetadata}
        * @memberof HistoryResponse
        */
        version: VersionMetadata;
        /**
        * 
        * @type {Array<Activity>}
        * @memberof HistoryResponse
        */
        data?: Array<Activity>;
    }

