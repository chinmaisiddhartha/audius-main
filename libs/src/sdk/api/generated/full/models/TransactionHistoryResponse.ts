// @ts-nocheck
/* tslint:disable */
/* eslint-disable */
/**
 * API
 * No description provided (generated by Openapi Generator https://github.com/openapitools/openapi-generator)
 *
 * The version of the OpenAPI document: 1.0
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */

import {
    TransactionDetails,
    TransactionDetailsFromJSON,
    TransactionDetailsFromJSONTyped,
    TransactionDetailsToJSON,
} from './TransactionDetails';
import {
    VersionMetadata,
    VersionMetadataFromJSON,
    VersionMetadataFromJSONTyped,
    VersionMetadataToJSON,
} from './VersionMetadata';

/**
 * 
 * @export
 * @interface TransactionHistoryResponse
 */
export interface TransactionHistoryResponse 
    {
        /**
        * 
        * @type {number}
        * @memberof TransactionHistoryResponse
        */
        latest_chain_block: number;
        /**
        * 
        * @type {number}
        * @memberof TransactionHistoryResponse
        */
        latest_indexed_block: number;
        /**
        * 
        * @type {number}
        * @memberof TransactionHistoryResponse
        */
        latest_chain_slot_plays: number;
        /**
        * 
        * @type {number}
        * @memberof TransactionHistoryResponse
        */
        latest_indexed_slot_plays: number;
        /**
        * 
        * @type {string}
        * @memberof TransactionHistoryResponse
        */
        signature: string;
        /**
        * 
        * @type {string}
        * @memberof TransactionHistoryResponse
        */
        timestamp: string;
        /**
        * 
        * @type {VersionMetadata}
        * @memberof TransactionHistoryResponse
        */
        version: VersionMetadata;
        /**
        * 
        * @type {Array<TransactionDetails>}
        * @memberof TransactionHistoryResponse
        */
        data?: Array<TransactionDetails>;
    }

