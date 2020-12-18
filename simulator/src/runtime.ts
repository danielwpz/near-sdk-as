import { spawnSync } from "child_process";
import * as os from "os";
import * as fs from "fs";
import {
  encodeBs58,
  assign,
  decodeState,
  encodeState,
  stateSize,
} from "./utils";
import {
  AccountContext,
  defaultAccountContext,
  createContext,
  VMContext,
  defaultContext,
} from "./context";
import {
  InternalState,
  DEFAULT_GAS,
  StandaloneOutput,
  ResultsObject,
  ExternalState,
} from "./types";

const DEFAULT_BALANCE = 1000000000000;

/**
 * Account object of client and contracts.
 */
export class Account {
  internalState: InternalState = {};
  balance: number = DEFAULT_BALANCE;
  lockedBalance = 0;
  signerAccountPk: string;
  storage_usage: number = 60;

  /**
   * Sholud only be constructed by a runtime instance.
   * @param account_id
   * @param wasmFile
   * @param runtime
   */
  constructor(
    public account_id: string,
    public wasmFile: string | null = null,
    public runtime: Runtime
  ) {
    this.signerAccountPk = encodeBs58(account_id.slice(0, 32).padEnd(32, " "));
    this.runtime.log(this.signerAccountPk);
    if (wasmFile != null && !fs.existsSync(wasmFile)) {
      throw new Error(`Path ${wasmFile} to contract wasm file doesn't exist`);
    }
  }

  private createAccountContext(
    input: any = {},
    prepaid_gas: number = DEFAULT_GAS
  ): Partial<AccountContext> {
    input = JSON.stringify(input);
    let accountContext = {
      input,
      prepaid_gas,
      signer_account_pk: this.account_id,
    };
    return accountContext;
  }

  /**
   * Single execution of contract method.
   * @param account_id contractId to call
   * @param method_name method to call
   * @param input object of arguments of method
   * @param prepaid_gas How much gas to use.
   */
  call_step_other(
    account_id: string,
    method_name: string,
    input: any = {},
    prepaid_gas: number = DEFAULT_GAS
  ) {
    if (this.runtime == null) throw new Error("Runtime is not set");
    let accountContext = this.createAccountContext(input, prepaid_gas);
    accountContext.signer_account_id = this.signerAccountPk;
    return this.runtime.call_step(
      account_id,
      method_name,
      accountContext.input,
      accountContext
    );
  }

  /**
   * Single execution of contract method to the same contract.
   * @param method_name method to call
   * @param input object of arguments of method
   * @param prepaid_gas How much gas to use.
   */
  call_step(method_name: string, input?: any, prepaid_gas?: number) {
    return this.call_step_other(
      this.account_id,
      method_name,
      input,
      prepaid_gas
    );
  }

  /**
   * Execute contract and any promises generated until no more promises are generated or gas runs out.
   * @param account_id Initial Contract to call.
   * @param method_name Method to call.
   * @param input object of input to method.
   * @param prepaid_gas How much gas to use.
   * @param attached_deposit How many tokens to send to the contract
   */
  call_other(
    account_id: string,
    method_name: string,
    input?: any,
    prepaid_gas: number = DEFAULT_GAS,
    attached_deposit: string = "0"
  ) {
    if (this.runtime == null) throw new Error("Runtime is not set");
    let accountContext = this.createAccountContext(input, prepaid_gas);
    accountContext.signer_account_id = this.account_id;
    if (attached_deposit) {
      accountContext.attached_deposit = attached_deposit;
    }
    this.runtime.log("Account Signer ID: " + accountContext.signer_account_id);
    this.runtime.log(accountContext);
    return this.runtime.call(
      account_id,
      method_name,
      accountContext.input,
      accountContext
    );
  }
  /**
   * Execute this contract and any promises generated until no more promises are generated or gas runs out.
   * @param method_name Method to call.
   * @param input object of input to method.
   * @param prepaid_gas How much gas to use.
   */
  call(method_name: string, input?: any, prepaid_gas?: number) {
    return this.call_other(this.account_id, method_name, input, prepaid_gas);
  }

  /**
   * View contract call to this contract.
   * @param method_name view method.
   * @param input object of input to method.
   */
  view(method_name: string, input?: any) {
    if (this.runtime == null) throw new Error("Runtime is not set");
    let accountContext = this.createAccountContext(input);
    accountContext.is_view = true;
    const result = this.runtime.call_step(
      this.account_id,
      method_name,
      accountContext.input,
      accountContext
    );
    var return_data = <any>(result.outcome && result.outcome.return_data);
    if (return_data && return_data.Value) {
      return_data = JSON.parse(return_data.Value);
    }
    const err = result["err"];
    return {
      return_data,
      err,
      result,
    };
  }

  /**
   * Current state of contract.
   */
  get state(): ExternalState {
    return decodeState(this.internalState);
  }

  set state(state: ExternalState) {
    this.internalState = encodeState(state);
    this.storage_usage = stateSize(state);
  }

  reset(): void {
    this.internalState = {};
    this.balance = DEFAULT_BALANCE;
    this.lockedBalance = 0;
    this.storage_usage = 60;
  }
}

export class Runtime {
  accounts: Map<string, Account> = new Map();
  context?: VMContext;

  constructor() {
    if (os.type() === "Windows_NT") {
      console.error("Windows is not supported.");
      process.exit(0);
    }
    /**
     * run binary if it doesn't exist so that it installs itself.
     */
    try {
      spawnSync("node", [__dirname + "/bin.js"]);
    } catch (e) {}
  }

  log(input: any): void {
    if (process.env.DEBUG) {
      console.log(input);
    }
  }

  newAccount(accoundId: string, wasmFile: string | null = null) {
    const account = new Account(accoundId, wasmFile, this);
    account.runtime = this;
    this.accounts.set(accoundId, account);
    return account;
  }

  getOrCreateAccount(account_id: string): Account {
    return this.accounts.get(account_id) || this.newAccount(account_id);
  }

  getAccount(account_id: string): Account {
    const account = this.accounts.get(account_id);
    if (account == undefined)
      throw new Error(account_id + " has not be added.");
    return account;
  }

  setContext(context: Partial<VMContext>) {
    this.context = { ...defaultContext(), ...context };
  }

  call_step(
    account_id: string,
    method_name: string,
    input: string = "",
    accountContext: Partial<AccountContext> = defaultAccountContext()
  ): StandaloneOutput {
    accountContext.signer_account_id =
      accountContext.signer_account_id || account_id;
    accountContext.input = input;
    accountContext.predecessor_account_id =
      accountContext.predecessor_account_id || accountContext.signer_account_id;
    const context = assign<AccountContext>(
      defaultAccountContext(),
      accountContext
    );
    const signer_account = this.getOrCreateAccount(context.signer_account_id);
    const predecessor_account = this.getAccount(context.predecessor_account_id);
    const account = this.getAccount(account_id);
    context.current_account_id = account.account_id;
    context.signer_account_pk = signer_account.signerAccountPk;
    context.account_balance = account.balance.toString();
    context.account_locked_balance = account.lockedBalance.toString();
    context.input = input;
    context.storage_usage = account.storage_usage;
    const vmContext = createContext(context, this.context);
    this.log(JSON.stringify(vmContext));
    let args = [
      __dirname + "/bin.js",
      "--context=" + JSON.stringify(vmContext),
      "--input=" + input,
      "--wasm-file=" + account.wasmFile,
      "--method-name=" + method_name,
      "--state=" + JSON.stringify(account.internalState),
    ];
    for (let data of accountContext.input_data || []) {
      args.push("--promise-results=" + JSON.stringify(data));
    }

    var result = this.spawn(args);
    if (!context.is_view && result.err == null) {
      account.balance = result.outcome.balance;
      account.internalState = result.state;
      account.storage_usage = result.outcome.storage_usage;
    }
    result.state = decodeState(result.state);
    this.log(result);
    return result;
  }

  call(
    account_id: string,
    method_name: string,
    input: string = "",
    accountContext: Partial<AccountContext>
  ) {
    const q = [
      {
        ...accountContext,
        index: 0,
        account_id,
        method_name,
        input,
      },
    ];
    var numReceipts = 1;
    const all_input_data: any = {};
    const all_output_data: any = {};
    var num_data = 0;
    var return_index = 0;
    const calls: any = {};
    const results: ResultsObject = {};
    while (q.length > 0) {
      let c = q.shift()!;
      let index = c["index"];
      let input_data = [];
      if (c.input_data) {
        for (let d of c.input_data) {
          if (all_input_data[d] != undefined) {
            input_data.push(all_input_data[d]);
          } else {
            break;
          }
        }
        if (input_data.length < c.input_data.length) {
          q.push(c);
          continue;
        }
      }
      let output_data = all_output_data[index] || [];
      calls[index] = c;
      this.log(
        `Call ${JSON.stringify(c)} Output ${JSON.stringify(output_data)}`
      );
      let accountContext = {
        ...c,
        output_data_receivers: output_data.map((d: any) => d.account_id),
        input_data,
      };
      let result = this.call_step(
        c.account_id,
        c.method_name,
        c.input,
        accountContext
      );
      results[index] = result;
      this.log(`Result:`);
      this.log(result);
      if (result) {
        if (result.outcome) {
          for (let log of result.outcome.logs) {
            this.log(`${c.account_id}: ${log}`);
          }
          if (result.err) {
            let result_data = { Failed: null };
            for (let d of output_data) {
              all_input_data[d.data_id] = result_data;
            }
          } else {
            let ret = result.outcome.return_data;
            if (typeof ret == "string" || ret.Value != undefined) {
              let result_data = {
                Successful: typeof ret == "string" ? "" : ret.Value,
              };
              for (let d of output_data) {
                all_input_data[d.data_id] = result_data;
              }
            } else if (ret.ReceiptIndex != undefined) {
              let adj_index = ret.ReceiptIndex + numReceipts;
              if (!all_output_data[adj_index]) {
                all_output_data[adj_index] = [];
              }
              for (let d of output_data) {
                all_output_data[adj_index].push(d);
              }
              if (return_index == index) {
                return_index = adj_index;
              }
            }
            for (let i in result.receipts) {
              const receipt = result.receipts[i];
              if (receipt.actions.length != 1) {
                throw new Error("reciept actions must have length 1");
              }
              const action = receipt.actions[0];
              const fca = action["FunctionCall"];
              let new_input_data = [];
              for (let ind of receipt["receipt_indices"]) {
                let data_id = num_data++;
                new_input_data.push(data_id);
                let adj_index = ind + numReceipts;
                if (all_output_data[adj_index] == undefined) {
                  all_output_data[adj_index] = [];
                }
                all_output_data[adj_index].push({
                  account_id: receipt["receiver_id"],
                  data_id,
                });
                // }
              }
              let next = {
                index: parseInt(i) + numReceipts,
                account_id: receipt["receiver_id"],
                method_name: fca["method_name"],
                input: fca["args"],
                signer_account_id: accountContext.signer_account_id,
                predecessor_account_id: c["account_id"],
                input_data: new_input_data,
                prepaid_gas: fca["gas"],
                attached_deposit: fca["deposit"],
              };
              q.push(next);
            }
            this.log(ret);
            numReceipts += result["receipts"].length;
          }
        }
      }
      this.log(
        `Queue:  ${q.map(
          (x) => `${x.predecessor_account_id} -> ${x.account_id}`
        )}`
      );
    }
    const result = results[return_index];
    this.log(`Final result:`);
    this.log(result);
    let return_data: any =
      (result.outcome && result.outcome.return_data) || undefined;
    if (return_data != undefined) {
      return_data =
        typeof return_data != "string" && return_data.Value
          ? JSON.parse(return_data.Value)
          : null;
    }
    return {
      return_data,
      err: result["err"],
      result,
      calls,
      results,
    };
  }

  reset() {
    this.accounts.forEach((account) => account.reset());
  }

  private spawn(args: string[]): any {
    let execResult = spawnSync("node", args);
    if (execResult.status != 0) {
      throw new Error(
        "Failed to run successfully: " + execResult.output[2].toString()
      );
    }
    var output = execResult.output[1];
    var result;
    try {
      result = JSON.parse(output);
    } catch (e) {
      console.error("Failed to parse: " + output);
      throw e;
    }
    return result;
  }
}
