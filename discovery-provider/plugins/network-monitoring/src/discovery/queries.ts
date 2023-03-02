import { AudiusLibs } from "@audius/sdk";
import { QueryTypes } from "sequelize";
import { getEnv } from "../config";
import { sequelizeConn } from "../db";
import { instrumentTracing, tracing } from "../tracer";
import { range } from "lodash";

const _createNewRun = async (): Promise<number> => {
  tracing.info("[+] starting new run");

  // Get block number
  const latestBlockNumberResp = await sequelizeConn.query(
    `
        SELECT number FROM blocks WHERE is_current = TRUE LIMIT 1;  
    `,
    {
      type: QueryTypes.SELECT,
    }
  );

  tracing.info(
    `[+] latest block number : ${
      (latestBlockNumberResp as { number: number }[])[0]!.number
    }`
  );
  const latestBlockNumber = (latestBlockNumberResp[0] as { number: number })
    .number;

  const runs = await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_index_blocks (
            is_current, 
            blocknumber, 
            is_complete,
            created_at
        ) VALUES (
            TRUE,
            :latestBlockNumber,
            FALSE,
            NOW()
        )
        RETURNING run_id;
    `,
    {
      type: QueryTypes.INSERT,
      replacements: { latestBlockNumber },
      logging: false,
    }
  );

  // Remove `is_current` from old run
  await sequelizeConn.query(
    `
        UPDATE network_monitoring_index_blocks 
        SET is_current = FALSE
        WHERE blocknumber != :latestBlockNumber;
    `,
    {
      replacements: { latestBlockNumber },
      logging: false,
    }
  );

  const run_id: number = (runs[0] as any)[0].run_id;
  tracing.info(`[+] current run id : ${run_id}`);

  return run_id;
};

export const createNewRun = instrumentTracing({
  fn: _createNewRun,
});

// Delete old runs so the postgres DB doesn't hog disk space
const _deleteOldRunData = async (run_id: number): Promise<void> => {
  tracing.info(`[${run_id}] deleting old run data`);

  // Number of runs to keep in the DB
  const latestRunsToKeep = 3;
  const toDelete = run_id - latestRunsToKeep;

  if (toDelete <= 0) {
    tracing.info("\t-> nothing to delete");
    return;
  }

  // Delete old runs
  tracing.info("\t-> network_monitoring_index_blocks + cascading");
  await sequelizeConn.query(
    `
        DELETE FROM network_monitoring_index_blocks
        WHERE run_id < :toDelete;
    `,
    {
      type: QueryTypes.DELETE,
      replacements: { toDelete },
    }
  );
};

export const deleteOldRunData = instrumentTracing({
  fn: _deleteOldRunData,
});

const _importContentNodes = async (run_id: number) => {
  tracing.info(`[${run_id}] importing content nodes`);

  const {
    ethRegistryAddress,
    ethTokenAddress,
    ethOwnerWallet,
    ethProviderUrl,
  } = getEnv();

  const ethWeb3Config = AudiusLibs.configEthWeb3(
    ethTokenAddress,
    ethRegistryAddress,
    ethProviderUrl,
    ethOwnerWallet,
    undefined,
    undefined
  );

  // @ts-ignore
  const audiusLibs = new AudiusLibs({
    ethWeb3Config,
    isServer: true,
    preferHigherPatchForPrimary: true,
    preferHigherPatchForSecondaries: true,
  });
  await audiusLibs.init();
  // const contentNodes = await audiusLibs.ServiceProvider?.listCreatorNodes();
  const numberOfProviders = await audiusLibs.ethContracts?.ServiceProviderFactoryClient.getTotalServiceTypeProviders(
    "content-node"
  ) || 0

  const contentNodes = await Promise.all(
    range(1, numberOfProviders + 1).map(
      async (i) => await audiusLibs.ethContracts?.ServiceProviderFactoryClient.getServiceEndpointInfo('content-node', i)
    )
  )
  if (contentNodes === undefined || contentNodes === null) {
    throw new Error("could not fetch content nodes");
  }

  await Promise.all(
    contentNodes.map(async (cnode) => {
      if (cnode === undefined || cnode === null) {
        return;
      }

      const { spID, endpoint } = cnode;

      await sequelizeConn.query(
        `
          INSERT INTO network_monitoring_content_nodes (
              spID, 
              endpoint, 
              run_id
          )
          VALUES (
              :spID,
              :endpoint,
              :run_id
          );
      `,
        {
          replacements: { run_id, spID, endpoint },
          logging: false,
        }
      );
    })
  );
};

export const importContentNodes = instrumentTracing({
  fn: _importContentNodes,
});

const _importUsers = async (run_id: number) => {
  tracing.info(`[${run_id}] importing users`);

  await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_users (
            user_id, 
            wallet, 
            replica_set, 
            run_id,
            primarySpID, 
            secondary1SpID, 
            secondary2SpID
        )
        SELECT 
            user_id, 
            wallet, 
            creator_node_endpoint as replica_set, 
            :run_id,
            primary_id as primarySpID, 
            secondary_ids[1] as secondary1SpID,
            secondary_ids[2] as secondary2SpID
        FROM users
        WHERE is_current = TRUE;
    `,
    {
      replacements: { run_id },
      logging: false,
    }
  );
};

export const importUsers = instrumentTracing({
  fn: _importUsers,
});

const _importCids = async (run_id: number) => {
  tracing.info(`[${run_id}] importing cids`);

  await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_cids_from_discovery (cid, run_id, ctype, user_id)
        SELECT metadata_multihash, :run_id, 'metadata', user_id
        FROM users
        WHERE metadata_multihash IS NOT NULL
        AND is_current = TRUE;
            `,
    {
      replacements: { run_id },
      logging: false,
    }
  );

  tracing.info(`\t -> users.metadata_multihash`);

  await sequelizeConn.query(
    `
            INSERT INTO network_monitoring_cids_from_discovery (cid, run_id, ctype, user_id)
            SELECT profile_picture, :run_id, 'image', user_id
            FROM users
            WHERE profile_picture IS NOT NULL
            AND profile_picture != '0'
            AND user_id IS NOT NULL
            AND is_current = TRUE;
                `,
    {
      replacements: { run_id },
      logging: false,
    }
  );

  tracing.info(`\t -> users.profile_picture`);

  await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_cids_from_discovery (cid, run_id, ctype, user_id)
        SELECT profile_picture_sizes, :run_id, 'dir', user_id
        FROM users
        WHERE profile_picture_sizes IS NOT NULL
        AND is_current = TRUE;
            `,
    {
      replacements: { run_id },
      logging: false,
    }
  );

  tracing.info(`\t -> users.profile_picture_sizes`);

  await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_cids_from_discovery (cid, run_id, ctype, user_id)
        SELECT cover_photo, :run_id, 'image', user_id
        FROM users
        WHERE cover_photo IS NOT NULL
        AND is_current = TRUE;
            `,
    {
      replacements: { run_id },
      logging: false,
    }
  );

  tracing.info(`\t -> users.cover_photo`);

  await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_cids_from_discovery (cid, run_id, ctype, user_id)
        SELECT cover_photo_sizes, :run_id, 'dir', user_id 
        FROM users 
        WHERE cover_photo_sizes IS NOT NULL
        AND is_current = TRUE;
            `,
    {
      replacements: { run_id },
      logging: false,
    }
  );

  tracing.info(`\t -> users.cover_photo_sizes`);

  await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_cids_from_discovery (cid, run_id, ctype, user_id)
        SELECT cover_art, :run_id, 'image', owner_id
        FROM tracks
        WHERE cover_art IS NOT NULL
        AND is_current = TRUE;
            `,
    {
      replacements: { run_id },
      logging: false,
    }
  );

  tracing.info(`\t -> tracks.cover_art`);

  await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_cids_from_discovery (cid, run_id, ctype, user_id)
        SELECT cover_art_sizes, :run_id, 'dir', owner_id
        FROM tracks 
        WHERE cover_art_sizes IS NOT NULL
        AND is_current = TRUE;
            `,
    {
      replacements: { run_id },
      logging: false,
    }
  );

  tracing.info(`\t -> tracks.cover_art_sizes`);

  await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_cids_from_discovery (cid, run_id, ctype, user_id)
        SELECT metadata_multihash, :run_id, 'metadata', owner_id
        FROM tracks 
        WHERE metadata_multihash IS NOT NULL
        AND is_current = TRUE;
            `,
    {
      replacements: { run_id },
      logging: false,
    }
  );

  tracing.info(`\t -> tracks.metadata_multihash`);

  await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_cids_from_discovery (cid, run_id, ctype, user_id)
        SELECT download -> 'cid' as cid, :run_id, 'track', owner_id
        FROM tracks 
        WHERE download -> 'cid' != 'null'
        AND is_current = TRUE;
            `,
    {
      replacements: { run_id },
      logging: false,
    }
  );

  tracing.info(`\t -> tracks.download->'cid'`);

  await sequelizeConn.query(
    `
        INSERT INTO network_monitoring_cids_from_discovery (cid, run_id, ctype, user_id)
        SELECT 
            jsonb_array_elements(track_segments) -> 'multihash', 
            :run_id, 
            'track',
            owner_id
        FROM tracks
        WHERE track_segments IS NOT NULL
        AND is_current = TRUE;
    `,
    {
      replacements: { run_id },
      logging: false,
    }
  );

  tracing.info(`\t -> tracks.track_segments->'multihash'`);
};

export const importCids = instrumentTracing({
  fn: _importCids,
});
