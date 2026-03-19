"use client";

import { FormEvent, useMemo, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { getPublicClient } from "@wagmi/core";
import { useAccount, useChainId, useConfig, useSwitchChain, useWalletClient } from "wagmi";
import { Address, formatUnits, isAddress, parseAbi, parseUnits } from "viem";
import { erc20Abi } from "@/lib/abi";
import { supportedChains } from "@/lib/wallet";

type DashboardState = {
  owner: string;
  token: string;
  symbol: string;
  decimals: number;
  balance: string;
};

type DetectedContractKind = "unknown" | "distributor" | "token";

const emptyState: DashboardState = {
  owner: "",
  token: "",
  symbol: "TOKEN",
  decimals: 18,
  balance: "0"
};

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
type SupportedChainId = (typeof supportedChains)[number]["id"];
const chainNameById = Object.fromEntries(supportedChains.map((chain) => [chain.id, chain.name])) as Record<
  number,
  string
>;
const defaultTokenGetter = "";

export default function Home() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const config = useConfig();
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync, isPending: switchingChain } = useSwitchChain();

  const [contractAddress, setContractAddress] = useState("");
  const [dashboard, setDashboard] = useState<DashboardState>(emptyState);
  const [detectedChainId, setDetectedChainId] = useState<number | null>(null);
  const [detectedContractKind, setDetectedContractKind] = useState<DetectedContractKind>("unknown");
  const [tokenGetter, setTokenGetter] = useState(defaultTokenGetter);
  const [depositAmount, setDepositAmount] = useState("");
  const [rewardUser, setRewardUser] = useState("");
  const [rewardAmount, setRewardAmount] = useState("");
  const [status, setStatus] = useState(
    "Enter a distributor or token contract address to detect it. Connect your wallet only when you want to use write actions."
  );
  const [loading, setLoading] = useState(false);

  const isOwner =
    Boolean(address) &&
    dashboard.owner.length > 0 &&
    address?.toLowerCase() === dashboard.owner.toLowerCase();

  const isCorrectChain = detectedChainId !== null && chainId === detectedChainId;
  const detectedChainName = detectedChainId ? chainNameById[detectedChainId] ?? `Chain #${detectedChainId}` : "";
  const isDistributor = detectedContractKind === "distributor";

  const formattedBalance = useMemo(() => {
    const amount = Number(dashboard.balance);
    if (!Number.isFinite(amount)) {
      return dashboard.balance;
    }

    return amount.toLocaleString("en-US", {
      maximumFractionDigits: 4
    });
  }, [dashboard.balance]);

  async function loadDashboard() {
    if (!isAddress(contractAddress)) {
      setStatus("Enter a valid contract or token address.");
      return;
    }

    try {
      setLoading(true);

      const distributorAddress = contractAddress as Address;
      const contractChainId = await detectContractChain(distributorAddress);

      if (!contractChainId) {
        setDetectedChainId(null);
        setDetectedContractKind("unknown");
        setDashboard(emptyState);
        setStatus("No contract code was found for this address on the supported chains. Check the address or the target network.");
        return;
      }

      setDetectedChainId(contractChainId);
      const contractClient = getPublicClient(config, { chainId: contractChainId });

      if (!contractClient) {
        setStatus("No public client is available for the detected chain.");
        return;
      }

      try {
        const resolvedTokenGetter = await resolveTokenGetterName(contractClient, distributorAddress, tokenGetter);
        const distributorAbi = {
          owner: buildReadAbi("owner", "address"),
          token: buildReadAbi(resolvedTokenGetter, "address"),
          balance: buildReadAbi("contractBalance", "uint256")
        };

        const [owner, rawToken, rawBalance] = await Promise.all([
          contractClient.readContract({
            address: distributorAddress,
            abi: distributorAbi.owner,
            functionName: "owner"
          }),
          contractClient.readContract({
            address: distributorAddress,
            abi: distributorAbi.token,
            functionName: resolvedTokenGetter
          }),
          contractClient.readContract({
            address: distributorAddress,
            abi: distributorAbi.balance,
            functionName: "contractBalance"
          })
        ]);

        if (!isAddress(rawToken)) {
          throw new Error(`The ${resolvedTokenGetter}() call did not return a valid token address.`);
        }

        const token = rawToken as Address;

        const [symbol, decimals] = await Promise.all([
          contractClient
            .readContract({
              address: token,
              abi: erc20Abi,
              functionName: "symbol"
            })
            .catch(() => "TOKEN"),
          contractClient
            .readContract({
              address: token,
              abi: erc20Abi,
              functionName: "decimals"
            })
            .catch(() => 18)
        ]);

        setDetectedContractKind("distributor");
        setDashboard({
          owner,
          token,
          symbol,
          decimals,
          balance: formatUnits(rawBalance, decimals)
        });

        if (isConnected && chainId !== contractChainId) {
          setStatus(
            `The distributor contract was found on ${chainNameById[contractChainId] ?? `Chain #${contractChainId}`}, but your wallet is connected to ${
              chainNameById[chainId] ?? `Chain #${chainId}`
            }. Switch to the contract chain before sending rewards or depositing tokens.`
          );
        } else {
          setStatus(
            `Contract synced on ${chainNameById[contractChainId] ?? `Chain #${contractChainId}`}. Token getter used: ${resolvedTokenGetter}().`
          );
        }
      } catch {
        const [symbol, decimals] = await Promise.all([
          contractClient
            .readContract({
              address: distributorAddress,
              abi: erc20Abi,
              functionName: "symbol"
            })
            .catch(() => null),
          contractClient
            .readContract({
              address: distributorAddress,
              abi: erc20Abi,
              functionName: "decimals"
            })
            .catch(() => null)
        ]);

        if (symbol !== null && decimals !== null) {
          setDetectedContractKind("token");
          setDashboard({
            owner: "",
            token: distributorAddress,
            symbol,
            decimals,
            balance: "0"
          });

          setStatus(
            `ERC-20 token detected on ${chainNameById[contractChainId] ?? `Chain #${contractChainId}`}. This address is a token contract, so custom reward/distributor actions are disabled.`
          );
          return;
        }

        throw new Error("This address has contract code, but the selected getter names did not match this contract. Try entering the correct token getter and other method names.");
      }
    } catch (error) {
      setDetectedContractKind("unknown");
      setDashboard(emptyState);
      setStatus(readError(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleDeposit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!walletClient || !address) {
      setStatus("A connected wallet is required to deposit tokens.");
      return;
    }

    if (!isAddress(contractAddress) || !isAddress(dashboard.token)) {
      setStatus("Load valid contract data before making a deposit.");
      return;
    }

    if (!detectedChainId || walletClient.chain.id !== detectedChainId) {
      setStatus(`Switch your wallet to ${detectedChainName || "the contract chain"} before depositing.`);
      return;
    }

    try {
      setLoading(true);
      const amount = parseUnits(depositAmount, dashboard.decimals);
      const chainClient = getPublicClient(config, { chainId: detectedChainId });

      if (!chainClient) {
        setStatus("No public client is available for the selected chain.");
        return;
      }

      const approvalHash = await walletClient.writeContract({
        account: address,
        address: dashboard.token as Address,
        abi: erc20Abi,
        functionName: "approve",
        args: [contractAddress as Address, amount],
        chain: walletClient.chain
      });

      setStatus(`Approval pending: ${approvalHash}`);
      const approvalReceipt = await chainClient.waitForTransactionReceipt({ hash: approvalHash });

      if (approvalReceipt.status !== "success") {
        throw new Error("Token approval failed or was reverted.");
      }

      const depositHash = await walletClient.writeContract({
        account: address,
        address: contractAddress as Address,
        abi: buildWriteAbi("deposit", ["uint256 amount"]),
        functionName: "deposit",
        args: [amount],
        chain: walletClient.chain
      });

      setStatus(`Deposit pending: ${depositHash}`);
      const depositReceipt = await chainClient.waitForTransactionReceipt({ hash: depositHash });

      if (depositReceipt.status !== "success") {
        throw new Error("Deposit transaction failed or was reverted.");
      }

      setDepositAmount("");
      await loadDashboard();
      setStatus("Deposit successful.");
    } catch (error) {
      setStatus(readError(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleReward(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!walletClient || !address) {
      setStatus("A connected wallet is required to send rewards.");
      return;
    }

    if (!isAddress(contractAddress) || !isAddress(rewardUser)) {
      setStatus("Enter a valid contract address and recipient address.");
      return;
    }

    if (!detectedChainId || walletClient.chain.id !== detectedChainId) {
      setStatus(`Switch your wallet to ${detectedChainName || "the contract chain"} before sending rewards.`);
      return;
    }

    try {
      setLoading(true);
      const amount = parseUnits(rewardAmount, dashboard.decimals);
      const chainClient = getPublicClient(config, { chainId: detectedChainId });

      if (!chainClient) {
        setStatus("No public client is available for the selected chain.");
        return;
      }

      const hash = await walletClient.writeContract({
        account: address,
        address: contractAddress as Address,
        abi: buildWriteAbi("sendReward", ["address user", "uint256 amount"]),
        functionName: "sendReward",
        args: [rewardUser as Address, amount],
        chain: walletClient.chain
      });

      setStatus(`Reward transfer pending: ${hash}`);
      const rewardReceipt = await chainClient.waitForTransactionReceipt({ hash });

      if (rewardReceipt.status !== "success") {
        throw new Error("Reward transaction failed or was reverted.");
      }

      setRewardAmount("");
      setRewardUser("");
      await loadDashboard();
      setStatus("Reward sent successfully.");
    } catch (error) {
      setStatus(readError(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleSwitchToContractChain() {
    if (!detectedChainId) {
      return;
    }

    try {
      await switchChainAsync({ chainId: detectedChainId });
      setStatus(`Switched to ${detectedChainName}. You can now use the write actions.`);
    } catch (error) {
      setStatus(readError(error));
    }
  }

  async function detectContractChain(addressToCheck: Address) {
    const matches = await Promise.all(
      supportedChains.map(async (chain) => {
        const client = getPublicClient(config, { chainId: chain.id });
        const bytecode = client ? await client.getBytecode({ address: addressToCheck }) : undefined;
        return bytecode && bytecode !== "0x" ? chain.id : null;
      })
    );

    return matches.find((value): value is SupportedChainId => value !== null) ?? null;
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <div className="site-logo">Reward Sender</div>
        <div className="site-header-actions">
          <ConnectButton showBalance={false} />
        </div>
      </header>

      {!walletConnectProjectId ? (
        <section className="project-warning">
          <strong>WalletConnect Project ID is missing.</strong>
          <p>
            Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` in `.env.local` so the RainbowKit connect modal can work
            correctly.
          </p>
        </section>
      ) : null}

      <section className="grid">
        <article className="panel panel-wide combined-panel">
          <div className="combined-layout">
            <div className="setup-column">
              <div className="panel-head">
                <h2>Contract Setup</h2>
                <span>{loading ? "Working..." : "Ready"}</span>
              </div>

              <label className="field">
                <span>Contract or token address</span>
                <input
                  value={contractAddress}
                  onChange={(event) => setContractAddress(event.target.value)}
                  placeholder="0x..."
                />
              </label>

              <div className="details-grid">
                <label className="field">
                  <span>Token getter</span>
                  <input
                    value={tokenGetter}
                    onChange={(event) => setTokenGetter(event.target.value.trim())}
                    placeholder="Enter token getter name"
                  />
                </label>
              </div>

              <div className="action-row">
                <button className="secondary-button" onClick={loadDashboard} disabled={loading}>
                  Load Contract Data
                </button>

                {detectedChainId && !isCorrectChain ? (
                  <button
                    className="secondary-button"
                    onClick={handleSwitchToContractChain}
                    disabled={switchingChain}
                  >
                    {switchingChain ? "Switching..." : `Switch to ${detectedChainName}`}
                  </button>
                ) : null}
              </div>

              <p className="status-text">{status}</p>
            </div>

            <div className="details-column">
              <div className="panel-head contract-details-head">
                <h2>Contract Details</h2>
                <span>{dashboard.symbol}</span>
              </div>

              <div className="details-grid">
                <div className="details-group">
                  <div className="details-group-head">Connection</div>
                  <div className="stat-card">
                    <span>Contract chain</span>
                    <strong>{detectedChainId ? `${detectedChainName} (#${detectedChainId})` : "Not detected"}</strong>
                  </div>
                  <div className={`stat-card ${isCorrectChain ? "chain-ok" : "chain-warn"}`}>
                    <span>Write status</span>
                    <strong>
                      {detectedChainId
                        ? isCorrectChain
                          ? "Wallet is on contract chain"
                          : `Switch wallet to ${detectedChainName}`
                        : "Load contract to detect chain"}
                    </strong>
                  </div>
                </div>

                <div className="details-group">
                  <div className="details-group-head">Contract</div>
                  <div className="stat-card">
                    <span>Owner</span>
                    <strong>{dashboard.owner || "Not loaded"}</strong>
                  </div>
                  <div className="stat-card">
                    <span>{isDistributor ? "Token contract address" : "Detected token address"}</span>
                    <strong>{dashboard.token || "Not loaded"}</strong>
                  </div>
                  <div className="stat-card accent">
                    <span>{isDistributor ? "Contract Balance" : "Detected token"}</span>
                    <strong>
                      {isDistributor ? `${formattedBalance} ${dashboard.symbol}` : dashboard.symbol}
                    </strong>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className={`owner-chip ${isOwner ? "owner-chip-live" : ""}`}>
            {isDistributor
              ? isOwner
                ? "Connected wallet is owner"
                : "Owner wallet required for write actions"
              : detectedContractKind === "token"
                ? "Token contract detected. Custom write actions need the right contract methods."
                : "Load a contract to enable custom actions"}
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>Deposit Tokens</h2>
            <span>Approve + deposit</span>
          </div>

          <form onSubmit={handleDeposit} className="form-stack">
            <label className="field">
              <span>Amount</span>
              <input
                value={depositAmount}
                onChange={(event) => setDepositAmount(event.target.value)}
                placeholder={`100 ${dashboard.symbol}`}
              />
            </label>

            <button
              className="primary-button"
              type="submit"
              disabled={loading || !isDistributor || !isOwner || !dashboard.token || !depositAmount || !isCorrectChain}
            >
              Deposit to Contract
            </button>
          </form>
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>Send Reward</h2>
            <span>Owner only</span>
          </div>

          <form onSubmit={handleReward} className="form-stack">
            <label className="field">
              <span>User wallet</span>
              <input
                value={rewardUser}
                onChange={(event) => setRewardUser(event.target.value)}
                placeholder="0xRecipient"
              />
            </label>

            <label className="field">
              <span>Reward amount</span>
              <input
                value={rewardAmount}
                onChange={(event) => setRewardAmount(event.target.value)}
                placeholder={`25 ${dashboard.symbol}`}
              />
            </label>

            <button
              className="primary-button"
              type="submit"
              disabled={loading || !isDistributor || !isOwner || !rewardUser || !rewardAmount || !isCorrectChain}
            >
              Send Reward
            </button>
          </form>
        </article>
      </section>

      <footer className="site-footer">
        <p><span>Built by </span>
        <a href="https://x.com/0xranjeet" target="_blank" rel="noreferrer">
        Ranjeet
        </a></p>
      </footer>
    </main>
  );
}

function readError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "An unknown error occurred. Check the browser console for more details.";
}

function buildReadAbi(functionName: string, returnType: string) {
  return parseAbi([`function ${functionName}() view returns (${returnType})`]);
}

function buildWriteAbi(functionName: string, args: string[]) {
  return parseAbi([`function ${functionName}(${args.join(", ")})`]);
}

function isValidFunctionName(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

async function tryReadAddressFunction(
  client: ReturnType<typeof getPublicClient>,
  address: Address,
  functionName: string
) {
  if (!client || !isValidFunctionName(functionName)) {
    return null;
  }

  try {
    const result = await client.readContract({
      address,
      abi: buildReadAbi(functionName, "address"),
      functionName
    });

    return isAddress(result) ? result : null;
  } catch {
    return null;
  }
}

async function resolveTokenGetterName(
  client: ReturnType<typeof getPublicClient>,
  address: Address,
  preferredName: string
) {
  const candidates = Array.from(
    new Set([preferredName, "ipToken", "token", "rewardToken", "paymentToken", "asset", "stakingToken"].filter(Boolean))
  );

  for (const candidate of candidates) {
    const tokenAddress = await tryReadAddressFunction(client, address, candidate);
    if (tokenAddress) {
      return candidate;
    }
  }

  throw new Error(
    `Could not detect the token getter automatically. Enter the correct token getter name, for example token(), ipToken(), rewardToken(), or your custom name like tokenxyz().`
  );
}
