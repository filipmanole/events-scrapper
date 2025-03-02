import { BigNumber, ethers } from "ethers";
import { FeeCollector__factory } from "lifi-contract-typings";
import {
  config,
  feeCollectorEventRepository,
  FeeCollectorEventRepository,
  scraperConfigRepository,
  ScraperConfigRepository,
} from "@evm-indexer/core";

type ScraperConfig = {
  chainId: number;
  contractAddress: string;
  providerUri: string;
};

export class EventScraper {
  #chainId: number;
  #provider: ethers.providers.JsonRpcProvider;
  #contract: ethers.Contract;

  #feeCollectedEventRepository: FeeCollectorEventRepository;
  #scraperConfigRepository: ScraperConfigRepository;

  constructor(params: ScraperConfig) {
    const { chainId, contractAddress, providerUri } = params;
    this.#chainId = chainId;
    this.#provider = new ethers.providers.JsonRpcProvider(providerUri);
    this.#contract = new ethers.Contract(
      contractAddress,
      FeeCollector__factory.createInterface(),
      this.#provider
    );
    this.#feeCollectedEventRepository = feeCollectorEventRepository;
    this.#scraperConfigRepository = scraperConfigRepository;
  }

  async processNextBatch(chunkSize: number): Promise<void> {
    try {
      const [lastProcessedBlock, currentBlock] = await Promise.all([
        this.#getLastProcessedBlock(this.#chainId),
        this.#provider
          .getBlockNumber()
          .then((b) => b - config.CONFIRMATION_BLOCKS),
      ]);

      if (lastProcessedBlock >= currentBlock) {
        console.info("No new blocks to process");
        return;
      }

      const toBlock = Math.min(lastProcessedBlock + chunkSize, currentBlock);

      console.info(`Processing blocks ${lastProcessedBlock + 1}-${toBlock}`);

      const events = await this.#loadEvents(lastProcessedBlock + 1, toBlock);

      await this.#saveEvents(events);
      await this.#scraperConfigRepository.updateForChainId(this.#chainId, {
        lastBlock: toBlock,
      });

      console.info(`Successfully processed up to block ${toBlock}`);
    } catch (error) {
      console.error("Error processing batch:", error);
      throw error;
    }
  }

  async #loadEvents(fromBlock: number, toBlock: number) {
    const filter = this.#contract.filters.FeesCollected();
    const events = await this.#contract.queryFilter(filter, fromBlock, toBlock);

    return Promise.all(
      events.map(async (event) => {
        const parsed = this.#contract.interface.parseLog(event);
        const block = await event.getBlock();

        return {
          chainId: this.#chainId,
          token: parsed.args[0],
          integrator: parsed.args[1],
          integratorFee: BigNumber.from(parsed.args[2]),
          lifiFee: BigNumber.from(parsed.args[3]),
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          logIndex: event.logIndex,
          timestamp: new Date(block.timestamp * 1000),
        };
      })
    );
  }

  async #saveEvents(events: any[]) {
    if (events.length === 0) return;

    try {
      const storedEvents = await this.#feeCollectedEventRepository.insertMany(
        events
      );
      console.info(`Stored ${storedEvents.length} events`);
    } catch (error: any) {
      if (error?.code === 11000) {
        console.warn(
          `Ignored ${error.result?.nInserted ?? 0} duplicate events`
        );
      } else {
        throw error;
      }
    }
  }

  async #getLastProcessedBlock(chainId: number): Promise<number> {
    const doc = await this.#scraperConfigRepository.findByChainId(chainId);
    return doc?.lastBlock ?? config.OLDEST_BLOCK;
  }
}
